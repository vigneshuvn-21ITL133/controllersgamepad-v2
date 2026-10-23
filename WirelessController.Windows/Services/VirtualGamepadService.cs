using Nefarius.ViGEm.Client;
using Nefarius.ViGEm.Client.Targets;
using Nefarius.ViGEm.Client.Targets.Xbox360;

namespace WirelessController.Windows.Services;

/// <summary>Requires the ViGEmBus driver to be installed on Windows.</summary>
public sealed class VirtualGamepadService : IDisposable
{
    private ViGEmClient? _client;
    private IXbox360Controller? _controller;
    private readonly object _gate = new();
    private bool _connected;
    public bool IsAvailable => _connected;
    public string? InitializationError { get; }

    public VirtualGamepadService()
    {
        try
        {
            _client = new ViGEmClient();
            _controller = _client.CreateXbox360Controller();
            _controller.Connect();
            _connected = true;
        }
        catch (Exception ex)
        {
            InitializationError = ex.Message;
            try { _controller?.Disconnect(); } catch { /* partial initialization */ }
            try { _client?.Dispose(); } catch { /* partial initialization */ }
            _controller = null;
            _client = null;
            _connected = false;
        }
    }

    public void Apply(InputMessage input)
    {
        lock (_gate)
        {
            if (!_connected) return;
            var buttons = new HashSet<string>(input.Buttons ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase);
            Set(Xbox360Button.A, buttons.Contains("A"));
            Set(Xbox360Button.B, buttons.Contains("B"));
            Set(Xbox360Button.X, buttons.Contains("X"));
            Set(Xbox360Button.Y, buttons.Contains("Y"));
            Set(Xbox360Button.LeftShoulder, buttons.Contains("LB"));
            Set(Xbox360Button.RightShoulder, buttons.Contains("RB"));
            Set(Xbox360Button.Back, buttons.Contains("BACK"));
            Set(Xbox360Button.Start, buttons.Contains("START"));
            Set(Xbox360Button.LeftThumb, buttons.Contains("L3"));
            Set(Xbox360Button.RightThumb, buttons.Contains("R3"));
            Set(Xbox360Button.Up, buttons.Contains("UP"));
            Set(Xbox360Button.Down, buttons.Contains("DOWN"));
            Set(Xbox360Button.Left, buttons.Contains("LEFT"));
            Set(Xbox360Button.Right, buttons.Contains("RIGHT"));
            _controller!.SetAxisValue(Xbox360Axis.LeftThumbX, Axis(input, "leftX"));
            _controller!.SetAxisValue(Xbox360Axis.LeftThumbY, (short)-Axis(input, "leftY"));
            _controller!.SetAxisValue(Xbox360Axis.RightThumbX, Axis(input, "rightX"));
            _controller!.SetAxisValue(Xbox360Axis.RightThumbY, (short)-Axis(input, "rightY"));
            _controller!.SetSliderValue(Xbox360Slider.LeftTrigger, Trigger(input, "leftTrigger"));
            _controller!.SetSliderValue(Xbox360Slider.RightTrigger, Trigger(input, "rightTrigger"));
        }
    }

    public void Reset()
    {
        lock (_gate)
        {
            if (!_connected) return;
            foreach (var button in new[] { Xbox360Button.A, Xbox360Button.B, Xbox360Button.X, Xbox360Button.Y,
                         Xbox360Button.LeftShoulder, Xbox360Button.RightShoulder, Xbox360Button.Back, Xbox360Button.Start,
                         Xbox360Button.LeftThumb, Xbox360Button.RightThumb, Xbox360Button.Up, Xbox360Button.Down,
                         Xbox360Button.Left, Xbox360Button.Right })
                _controller!.SetButtonState(button, false);
            _controller!.SetAxisValue(Xbox360Axis.LeftThumbX, 0);
            _controller!.SetAxisValue(Xbox360Axis.LeftThumbY, 0);
            _controller!.SetAxisValue(Xbox360Axis.RightThumbX, 0);
            _controller!.SetAxisValue(Xbox360Axis.RightThumbY, 0);
            _controller!.SetSliderValue(Xbox360Slider.LeftTrigger, 0);
            _controller!.SetSliderValue(Xbox360Slider.RightTrigger, 0);
        }
    }

    private void Set(Xbox360Button button, bool down) => _controller!.SetButtonState(button, down);
    private static short Axis(InputMessage input, string key)
    {
        var v = input.Axes is not null && input.Axes.TryGetValue(key, out var value) ? value : 0;
        v = Math.Clamp(v, -1d, 1d);
        return (short)Math.Round(v * (v < 0 ? 32768 : 32767));
    }
    private static byte Trigger(InputMessage input, string key)
    {
        var v = input.Axes is not null && input.Axes.TryGetValue(key, out var value) ? value : 0;
        return (byte)Math.Round(Math.Clamp(v, 0d, 1d) * 255d);
    }
    public void Dispose()
    {
        lock (_gate)
        {
            if (!_connected) return;
            Reset();
            _controller?.Disconnect();
            _connected = false;
            _controller = null;
            _client?.Dispose();
            _client = null;
        }
    }
}
