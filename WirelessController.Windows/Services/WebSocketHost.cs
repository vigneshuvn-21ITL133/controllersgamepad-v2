using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace WirelessController.Windows.Services;

/// <summary>Single-client, one-time-paired WebSocket server for controller and desktop input.</summary>
public sealed class WebSocketHost : IAsyncDisposable
{
    public const int Port = 8557;
    private readonly PairingManager _pairing;
    private readonly VirtualGamepadService _gamepad;
    private readonly DesktopInputService _desktop;
    private readonly Action<string> _status;
    private readonly Action<bool> _connectedChanged;
    private WebApplication? _app;
    private WebSocket? _activeSocket;
    private int _clientClaimed;
    private int _clientConnected;
    private long _lastInputTicks;
    private long _receivedPackets;
    private CancellationTokenSource? _watchdogCts;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public bool IsRunning => _app is not null;
    public bool IsClientConnected => Volatile.Read(ref _clientConnected) == 1;
    public long ReceivedPackets => Interlocked.Read(ref _receivedPackets);
    public DateTime? LastPacketAt
    {
        get
        {
            var ticks = Interlocked.Read(ref _lastInputTicks);
            return ticks == 0 ? null : new DateTime(ticks, DateTimeKind.Utc).ToLocalTime();
        }
    }

    public WebSocketHost(PairingManager pairing, VirtualGamepadService gamepad, DesktopInputService desktop, Action<string> status, Action<bool> connectedChanged)
    {
        _pairing = pairing;
        _gamepad = gamepad;
        _desktop = desktop;
        _status = status;
        _connectedChanged = connectedChanged;
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_app is not null) return;
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.ListenAnyIP(Port));
        var app = builder.Build();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });
        app.Run(HandleRequestAsync);
        await app.StartAsync(cancellationToken);
        _app = app;
        _watchdogCts = new CancellationTokenSource();
        _ = WatchdogAsync(_watchdogCts.Token);
        _status($"V_Control WebSocket listener running on port {Port}");
    }

    private async Task HandleRequestAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status426UpgradeRequired;
            await context.Response.WriteAsync("WebSocket required");
            return;
        }
        if (Interlocked.CompareExchange(ref _clientClaimed, 1, 0) != 0)
        {
            context.Response.StatusCode = StatusCodes.Status409Conflict;
            return;
        }

        var paired = false;
        try
        {
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            Volatile.Write(ref _activeSocket, socket);
            var requestToken = context.RequestAborted;
            try
            {
                using var handshakeTimeout = CancellationTokenSource.CreateLinkedTokenSource(requestToken);
                handshakeTimeout.CancelAfter(TimeSpan.FromSeconds(8));
                var first = await ReceiveTextAsync(socket, handshakeTimeout.Token);
                if (first is null) return;
                PairMessage? pair;
                try { pair = JsonSerializer.Deserialize<PairMessage>(first, JsonOptions); }
                catch { await SendAsync(socket, "{\"type\":\"error\",\"message\":\"Invalid pairing message\"}"); return; }
                if (pair is null || !string.Equals(pair.Type, "pair", StringComparison.OrdinalIgnoreCase))
                {
                    await SendAsync(socket, "{\"type\":\"error\",\"message\":\"Invalid pairing request. Generate a fresh code on the PC.\"}");
                    await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Invalid pairing request", CancellationToken.None);
                    return;
                }

                var pairingResult = _pairing.TryConsumeDetailed(pair.Code);
                if (pairingResult != PairingConsumeResult.Accepted)
                {
                    var message = pairingResult switch
                    {
                        PairingConsumeResult.Expired => "Pairing code expired. Generate a fresh code on the PC and connect within 5 minutes.",
                        PairingConsumeResult.MissingOrAlreadyUsed => "No active pairing code exists, or it was already used. Generate a fresh code on the PC.",
                        _ => "Pairing code does not match. Enter the exact six-digit code currently shown on the PC."
                    };
                    await SendAsync(socket, JsonSerializer.Serialize(new { type = "error", message }));
                    await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Pairing rejected", CancellationToken.None);
                    _status($"Pairing rejected: {message}");
                    return;
                }

                paired = true;
                Interlocked.Exchange(ref _clientConnected, 1);
                Interlocked.Exchange(ref _lastInputTicks, DateTime.UtcNow.Ticks);
                _connectedChanged(true);
                _status("Phone paired and connected");
                await SendAsync(socket, "{\"type\":\"paired\",\"protocol\":1,\"message\":\"Connected\"}");

                while (socket.State == WebSocketState.Open && !requestToken.IsCancellationRequested)
                {
                    var json = await ReceiveTextAsync(socket, requestToken);
                    if (json is null) break;
                    if (json.Length > 16_384)
                    {
                        await socket.CloseAsync(WebSocketCloseStatus.MessageTooBig, "Input message too large", CancellationToken.None);
                        break;
                    }
                    Interlocked.Increment(ref _receivedPackets);
                    try
                    {
                        using var document = JsonDocument.Parse(json);
                        if (!document.RootElement.TryGetProperty("type", out var typeElement)) continue;
                        var type = typeElement.GetString();
                        if (string.Equals(type, "input", StringComparison.OrdinalIgnoreCase))
                        {
                            var input = JsonSerializer.Deserialize<InputMessage>(json, JsonOptions);
                            if (input is null) continue;
                            _gamepad.Apply(Sanitize(input));
                            Interlocked.Exchange(ref _lastInputTicks, DateTime.UtcNow.Ticks);
                        }
                        else if (string.Equals(type, "desktop", StringComparison.OrdinalIgnoreCase))
                        {
                            var command = JsonSerializer.Deserialize<DesktopMessage>(json, JsonOptions);
                            if (command is not null) ApplyDesktopCommand(command);
                            Interlocked.Exchange(ref _lastInputTicks, DateTime.UtcNow.Ticks);
                        }
                        else if (string.Equals(type, "ping", StringComparison.OrdinalIgnoreCase))
                        {
                            var ping = JsonSerializer.Deserialize<PingMessage>(json, JsonOptions);
                            if (ping is not null)
                                await SendAsync(socket, JsonSerializer.Serialize(new { type = "pong", clientTime = ping.ClientTime, serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }));
                        }
                    }
                    catch (JsonException) { /* Ignore malformed packet; do not let it terminate the listener. */ }
                    catch (Exception ex) { _status($"Input rejected: {ex.Message}"); }
                }
            }
            catch (WebSocketException ex) { _status($"Phone disconnected: {ex.WebSocketErrorCode}"); }
            catch (OperationCanceledException) { }
            finally
            {
                if (paired)
                {
                    _gamepad.Reset();
                    _desktop.ReleaseAll();
                    Interlocked.Exchange(ref _lastInputTicks, 0);
                    Interlocked.Exchange(ref _clientConnected, 0);
                    _connectedChanged(false);
                    _status("Phone disconnected; controller and desktop input released");
                }
            }
        }
        catch (Exception ex) { _status($"WebSocket client error: {ex.Message}"); }
        finally
        {
            Interlocked.Exchange(ref _activeSocket, null);
            Interlocked.Exchange(ref _clientClaimed, 0);
        }
    }

    /// <summary>Ask the currently connected phone to close without stopping the listener.</summary>
    public async Task DisconnectClientAsync(string reason = "Disconnected from Windows companion")
    {
        var socket = Volatile.Read(ref _activeSocket);
        if (socket is null || socket.State != WebSocketState.Open) return;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, reason, timeout.Token); }
        catch (WebSocketException) { /* The client may already have disconnected. */ }
        catch (OperationCanceledException) { /* The request can complete asynchronously after the UI action. */ }
    }

    private void ApplyDesktopCommand(DesktopMessage command)
    {
        switch (command.Action?.ToLowerInvariant())
        {
            case "key": _desktop.SetKey(command.Key, command.Down == true); break;
            case "type": _desktop.TypeText(command.Text); break;
            case "move": _desktop.MoveMouse(Math.Clamp(command.Dx ?? 0, -1200, 1200), Math.Clamp(command.Dy ?? 0, -1200, 1200)); break;
            case "mousebutton": _desktop.SetMouseButton(command.Button, command.Down == true); break;
            case "scroll": _desktop.Scroll(Math.Clamp(command.Delta ?? 0, -1200, 1200)); break;
        }
    }

    private static InputMessage Sanitize(InputMessage input)
    {
        var allowed = new HashSet<string>(new[] { "A", "B", "X", "Y", "LB", "RB", "BACK", "START", "L3", "R3", "UP", "DOWN", "LEFT", "RIGHT" }, StringComparer.OrdinalIgnoreCase);
        var buttons = (input.Buttons ?? Array.Empty<string>()).Where(allowed.Contains).Distinct(StringComparer.OrdinalIgnoreCase).Take(14).ToArray();
        var axes = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in new[] { "leftX", "leftY", "rightX", "rightY", "leftTrigger", "rightTrigger" })
        {
            var value = input.Axes is not null && input.Axes.TryGetValue(key, out var v) && double.IsFinite(v) ? v : 0;
            axes[key] = Math.Clamp(value, key.Contains("Trigger", StringComparison.OrdinalIgnoreCase) ? 0 : -1, 1);
        }
        return new InputMessage("input", buttons, axes);
    }

    private async Task WatchdogAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(150));
        try
        {
            while (await timer.WaitForNextTickAsync(token))
            {
                var last = Interlocked.Read(ref _lastInputTicks);
                if (last != 0 && DateTime.UtcNow - new DateTime(last, DateTimeKind.Utc) > TimeSpan.FromMilliseconds(650))
                {
                    _gamepad.Reset();
                    _desktop.ReleaseAll();
                    Interlocked.Exchange(ref _lastInputTicks, 0);
                    _status("Input heartbeat timed out; all held input was released for safety");
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private static async Task<string?> ReceiveTextAsync(WebSocket socket, CancellationToken token)
    {
        var buffer = new byte[4096];
        using var stream = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), token);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            if (result.MessageType != WebSocketMessageType.Text) continue;
            stream.Write(buffer, 0, result.Count);
            if (stream.Length > 16_384) return null;
            if (result.EndOfMessage) return Encoding.UTF8.GetString(stream.ToArray());
        }
    }

    private static Task SendAsync(WebSocket socket, string text) => socket.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, CancellationToken.None);

    public async ValueTask DisposeAsync()
    {
        _watchdogCts?.Cancel();
        _watchdogCts?.Dispose();
        _pairing.Clear();
        _gamepad.Reset();
        _desktop.ReleaseAll();
        if (_app is not null)
        {
            using var stopCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await _app.StopAsync(stopCts.Token);
            await _app.DisposeAsync();
            _app = null;
        }
    }
}
