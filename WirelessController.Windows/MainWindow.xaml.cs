using System.Collections.ObjectModel;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using QRCoder;
using WirelessController.Windows.Services;

namespace WirelessController.Windows;

public partial class MainWindow : Window
{
    private readonly PairingManager _pairing = new();
    private readonly ObservableCollection<string> _logs = new();
    private readonly DispatcherTimer _uiTimer = new() { Interval = TimeSpan.FromMilliseconds(500) };
    private WebSocketHost? _host;
    private VirtualGamepadService? _gamepad;
    private DesktopInputService? _desktopInput;
    private string? _localAddress;
    private DateTimeOffset? _pairingExpiresAt;
    private AppSettings _settings = new();
    private bool _loadingSettings;

    public MainWindow()
    {
        InitializeComponent();
        LogList.ItemsSource = _logs;
        LoadSettings();
        _uiTimer.Tick += (_, _) =>
        {
            try { RefreshLiveStatus(); }
            catch (Exception ex)
            {
                App.WriteDiagnostic("Periodic dashboard refresh failed", ex);
                _uiTimer.Stop();
                Log($"Dashboard refresh failed; timer paused. Details: {ex.Message}", true);
                SetHomeStatus($"Dashboard refresh encountered an error. See {App.CrashLogPath}");
            }
        };
        _uiTimer.Start();
        Loaded += MainWindow_Loaded;
        Log("V_Control desktop companion opened");
        RefreshLiveStatus();
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        if (_settings.AutoStartServer) await StartServerAsync();
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        // Let the title-bar buttons handle their own click. Any other title-bar area drags the window.
        if (e.ChangedButton != MouseButton.Left) return;
        if (e.OriginalSource is DependencyObject source && FindAncestor<Button>(source) is not null) return;
        if (e.ClickCount == 2)
        {
            ToggleWindowState();
            return;
        }
        try { DragMove(); } catch (InvalidOperationException) { /* Drag can end before WPF starts it. */ }
    }

    private static T? FindAncestor<T>(DependencyObject? current) where T : DependencyObject
    {
        while (current is not null)
        {
            if (current is T match) return match;
            current = System.Windows.Media.VisualTreeHelper.GetParent(current);
        }
        return null;
    }

    private void MinimizeWindow_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void MaximizeWindow_Click(object sender, RoutedEventArgs e) => ToggleWindowState();
    private void CloseWindow_Click(object sender, RoutedEventArgs e) => Close();

    private async void DisconnectPhone_Click(object sender, RoutedEventArgs e)
    {
        if (_host is null || !_host.IsClientConnected) return;
        try
        {
            await _host.DisconnectClientAsync();
            Log("Phone disconnect requested from the Windows dashboard");
        }
        catch (Exception ex)
        {
            Log($"Could not disconnect phone cleanly: {ex.Message}", true);
            SetHomeStatus("Could not disconnect the phone cleanly. Check the logs for details.");
        }
    }

    private void ToggleWindowState()
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        MaximizeWindowButton.Content = WindowState == WindowState.Maximized ? "❐" : "□";
    }

    private void HomeNav_Click(object sender, RoutedEventArgs e) => ShowPage("Home");
    private void DevicesNav_Click(object sender, RoutedEventArgs e) => ShowPage("Devices");
    private void SettingsNav_Click(object sender, RoutedEventArgs e) => ShowPage("Settings");
    private void DiagnosticsNav_Click(object sender, RoutedEventArgs e) => ShowPage("Diagnostics");
    private void GamepadNav_Click(object sender, RoutedEventArgs e) => ShowPage("Gamepad");
    private void KeyboardNav_Click(object sender, RoutedEventArgs e) => ShowPage("Keyboard");
    private void MouseNav_Click(object sender, RoutedEventArgs e) => ShowPage("Mouse");
    private void LogsNav_Click(object sender, RoutedEventArgs e) => ShowPage("Logs");

    private void ShowPage(string page)
    {
        HomePage.Visibility = page == "Home" ? Visibility.Visible : Visibility.Collapsed;
        DevicesPage.Visibility = page == "Devices" ? Visibility.Visible : Visibility.Collapsed;
        GamepadPage.Visibility = page == "Gamepad" ? Visibility.Visible : Visibility.Collapsed;
        KeyboardPage.Visibility = page == "Keyboard" ? Visibility.Visible : Visibility.Collapsed;
        MousePage.Visibility = page == "Mouse" ? Visibility.Visible : Visibility.Collapsed;
        DiagnosticsPage.Visibility = page == "Diagnostics" ? Visibility.Visible : Visibility.Collapsed;
        SettingsPage.Visibility = page == "Settings" ? Visibility.Visible : Visibility.Collapsed;
        LogsPage.Visibility = page == "Logs" ? Visibility.Visible : Visibility.Collapsed;
        PageTitle.Text = page switch
        {
            "Home" => "Dashboard", "Devices" => "Pairing", "Gamepad" => "Gamepad Controller",
            "Keyboard" => "Keyboard Control", "Mouse" => "Mouse Control", "Settings" => "Settings",
            "Diagnostics" => "System Diagnostics", "Logs" => "Application Logs", _ => page
        };
        var nav = page switch
        {
            "Home" => HomeNav, "Devices" => DevicesNav, "Settings" => SettingsNav,
            "Diagnostics" => DiagnosticsNav, "Gamepad" => GamepadNav, "Keyboard" => KeyboardNav,
            "Mouse" => MouseNav, _ => LogsNav
        };
        SetActive(nav);
        RefreshLiveStatus();
        if (page == "Diagnostics") RefreshDiagnostics();
    }

    private void SetActive(Button active)
    {
        foreach (var button in new[] { HomeNav, DevicesNav, SettingsNav, DiagnosticsNav, GamepadNav, KeyboardNav, MouseNav, LogsNav })
            button.Tag = button == active ? "Active" : null;
    }

    private async void StartServer_Click(object sender, RoutedEventArgs e)
    {
        if (_host is not null)
        {
            await StopServerAsync();
            return;
        }
        await StartServerAsync();
    }

    private async Task StartServerAsync()
    {
        if (_host is not null) return;
        _localAddress = GetLocalIPv4();
        if (_localAddress is null)
        {
            SetHomeStatus("No active IPv4 address found. Connect the PC to Wi-Fi or Ethernet and retry.");
            Log("Server start blocked: no usable IPv4 adapter was found", true);
            return;
        }

        AddressText.Text = $"{_localAddress}:{WebSocketHost.Port}";
        StartServerButton.IsEnabled = false;
        try
        {
            _gamepad = new VirtualGamepadService();
            _desktopInput = new DesktopInputService();
            _host = new WebSocketHost(_pairing, _gamepad, _desktopInput, SetStatusFromAnyThread, SetConnectedFromAnyThread);
            await _host.StartAsync();
            StartServerButton.Content = "Stop connection server";
            PairingServerButton.Content = "Stop server";
            PairingButton.IsEnabled = true;
            SetHomeStatus(_gamepad.IsAvailable
                ? "Listener is running. Generate a pairing code and scan it from the V_Control mobile app."
                : "Listener is running; desktop control works. Install ViGEmBus to enable the virtual gamepad.");
            Log($"Listener started at ws://{_localAddress}:{WebSocketHost.Port}");
            if (!_gamepad.IsAvailable)
                Log($"Virtual gamepad unavailable: {_gamepad.InitializationError ?? "ViGEmBus initialization failed"}. Desktop keyboard/mouse remains available.", true);
            PairingCode_Click(this, new RoutedEventArgs());
            RefreshLiveStatus();
        }
        catch (Exception ex)
        {
            if (_host is not null) await _host.DisposeAsync();
            _host = null;
            _desktopInput?.Dispose();
            _desktopInput = null;
            _gamepad?.Dispose();
            _gamepad = null;
            StartServerButton.Content = "Start connection server";
            PairingServerButton.Content = "Start server";
            PairingButton.IsEnabled = false;
            SetHomeStatus("Could not start the listener. Check whether port 8557 is free and Windows Firewall allows Private-network access.");
            Log($"Server startup failed: {ex.Message}", true);
            MessageBox.Show(ex.Message, "V_Control startup failed", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally { StartServerButton.IsEnabled = true; RefreshLiveStatus(); }
    }

    private async Task StopServerAsync()
    {
        if (_host is null) return;
        StartServerButton.IsEnabled = false;
        try { await _host.DisposeAsync(); }
        catch (Exception ex) { Log($"Server shutdown warning: {ex.Message}", true); }
        _host = null;
        _pairing.Clear();
        _pairingExpiresAt = null;
        _desktopInput?.ReleaseAll();
        _desktopInput?.Dispose();
        _desktopInput = null;
        _gamepad?.Dispose();
        _gamepad = null;
        PairingQrImage.Source = null;
        PairingQrImage.Visibility = Visibility.Collapsed;
        QrEmptyState.Visibility = Visibility.Visible;
        PairingQrImageLarge.Source = null;
        PairingQrImageLarge.Visibility = Visibility.Collapsed;
        QrEmptyStateLarge.Visibility = Visibility.Visible;
        PairingCodeText.Text = "PAIR CODE  ·  — — — — — —";
        PairingExpiryText.Text = "One-time code · valid for 5 minutes";
        PairingCodeTextLarge.Text = "— — — — — —";
        PairingExpiryTextLarge.Text = "One-time code · valid for 5 minutes";
        PairingButton.IsEnabled = false;
        StartServerButton.Content = "Start connection server";
        PairingServerButton.Content = "Start server";
        AddressText.Text = "Start the connection server first";
        SetHomeStatus("Connection server stopped. All active input has been released.");
        Log("Listener stopped; all input released");
        StartServerButton.IsEnabled = true;
        RefreshLiveStatus();
    }

    private void PairingCode_Click(object sender, RoutedEventArgs e)
    {
        if (_host is null || _localAddress is null)
        {
            SetHomeStatus("Start the connection server before generating a pairing code.");
            return;
        }

        try
        {
            var (code, expiresAt) = _pairing.Create(TimeSpan.FromMinutes(5));
            _pairingExpiresAt = expiresAt;
            // Millisecond-precision UTC ISO string: the phone's JS engine parses this reliably, unlike 7-digit .NET "o" output.
            var expiresText = expiresAt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
            var payload = new PairingPayload(_localAddress, WebSocketHost.Port, code, expiresText, "wireless-controller-v1");
            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

            using var generator = new QRCodeGenerator();
            using var data = generator.CreateQrCode(json, QRCodeGenerator.ECCLevel.M);
            var qr = new PngByteQRCode(data);
            var png = qr.GetGraphic(8);
            if (png.Length == 0) throw new InvalidOperationException("The QR encoder returned an empty image.");

            var bitmap = new BitmapImage();
            using (var stream = new MemoryStream(png, writable: false))
            {
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.CreateOptions = BitmapCreateOptions.PreservePixelFormat;
                bitmap.StreamSource = stream;
                bitmap.EndInit();
                bitmap.Freeze();
            }

            PairingQrImage.Source = bitmap;
            PairingQrImage.Visibility = Visibility.Visible;
            QrEmptyState.Visibility = Visibility.Collapsed;
            PairingQrImageLarge.Source = bitmap;
            PairingQrImageLarge.Visibility = Visibility.Visible;
            QrEmptyStateLarge.Visibility = Visibility.Collapsed;
            PairingCodeText.Text = $"PAIR CODE  ·  {code}";
            PairingExpiryText.Text = $"Expires at {expiresAt.ToLocalTime():HH:mm:ss} · single use";
            PairingCodeTextLarge.Text = code;
            PairingExpiryTextLarge.Text = $"Expires at {expiresAt.ToLocalTime():HH:mm:ss} · single use";
            SetHomeStatus("Pairing code generated. Scan the QR code with V_Control on your phone within 5 minutes.");
            Log($"One-time pairing code generated; expires {expiresAt.ToLocalTime():HH:mm:ss}");
        }
        catch (Exception ex)
        {
            _pairing.Clear();
            _pairingExpiresAt = null;
            App.WriteDiagnostic("Pairing QR generation failed", ex);
            PairingQrImage.Source = null;
            PairingQrImage.Visibility = Visibility.Collapsed;
            QrEmptyState.Visibility = Visibility.Visible;
            PairingQrImageLarge.Source = null;
            PairingQrImageLarge.Visibility = Visibility.Collapsed;
            QrEmptyStateLarge.Visibility = Visibility.Visible;
            PairingCodeText.Text = "PAIR CODE  ·  NOT AVAILABLE";
            PairingExpiryText.Text = "QR generation failed";
            PairingCodeTextLarge.Text = "QR generation failed";
            PairingExpiryTextLarge.Text = "See the diagnostic log for details";
            SetHomeStatus("The server is running, but the QR code could not be generated. See the diagnostic log for details.");
            Log($"QR generation failed: {ex}", true);
            MessageBox.Show(
                $"V_Control could not generate the pairing QR code.\n\nError: {ex.Message}\n\nDiagnostic log: {App.CrashLogPath}",
                "V_Control - QR generation error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void RefreshLiveStatus()
    {
        var running = _host?.IsRunning == true;
        var connected = _host?.IsClientConnected == true;
        var onlineBrush = new SolidColorBrush(Color.FromRgb(21, 148, 91));
        var offlineBrush = new SolidColorBrush(Color.FromRgb(217, 61, 72));
        var neutralBrush = new SolidColorBrush(Color.FromRgb(135, 147, 161));
        DisconnectPhoneButton.Visibility = connected ? Visibility.Visible : Visibility.Collapsed;
        HeaderStatusText.Text = connected ? "Connected" : running ? "Waiting for phone" : "Disconnected";
        HeaderStatusText.Foreground = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        HeaderStatusDot.Fill = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        HomeConnectionValue.Text = connected ? "Connected" : running ? "Waiting for phone" : "Disconnected";
        HomeConnectionDot.Fill = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        ServerValue.Text = running ? "Running" : "Stopped";
        ServerValue.Foreground = running ? onlineBrush : offlineBrush;
        ServerAddressSmall.Text = running ? $"{_localAddress}:{WebSocketHost.Port}" : "Port 8557 · WebSocket";
        DriverValue.Text = _gamepad?.IsAvailable == true ? "Ready" : _gamepad is null ? "Stopped" : "Unavailable";
        DriverValue.Foreground = _gamepad?.IsAvailable == true ? onlineBrush : _gamepad is null ? neutralBrush : offlineBrush;
        DriverDescription.Text = _gamepad?.IsAvailable == true ? "Xbox 360-compatible" : _gamepad is null ? "Not initialized" : "ViGEmBus is required";
        PairingServerButton.Content = running ? "Stop server" : "Start server";
        FooterStatus.Text = connected ? "CONNECTED · INPUT ACTIVE" : running ? "SERVER ONLINE · WAITING FOR PAIRING" : "DISCONNECTED · SERVER STOPPED";
        PacketCountValue.Text = (_host?.ReceivedPackets ?? 0).ToString("N0");
        GamepadPacketCount.Text = $"{(_host?.ReceivedPackets ?? 0):N0} packets";
        var lastPacket = _host?.LastPacketAt;
        LastPacketValue.Text = lastPacket.HasValue ? $"Last: {lastPacket.Value:HH:mm:ss}" : "Last packet: never";
        if (_pairingExpiresAt is DateTimeOffset pairingExpiry)
        {
            var remaining = pairingExpiry - DateTimeOffset.UtcNow;
            var expiryLabel = remaining > TimeSpan.Zero
                ? $"Expires in {Math.Max(0, (int)remaining.TotalMinutes):00}:{Math.Max(0, remaining.Seconds):00} · single use"
                : "Code expired · generate a fresh one";
            PairingExpiryText.Text = expiryLabel;
            PairingExpiryTextLarge.Text = expiryLabel;
            if (remaining <= TimeSpan.Zero) _pairingExpiresAt = null;
        }
        GamepadStatusDot.Fill = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        GamepadConnectionText.Text = connected ? "Controller connected" : running ? "Waiting for phone" : "Offline";
        GamepadConnectionText.Foreground = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        KeyboardStatusDot.Fill = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        KeyboardConnectionText.Text = connected ? "Input active" : running ? "Server ready" : "Offline";
        KeyboardConnectionText.Foreground = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        KeyboardInputCountText.Text = $"Input packets received: {(_host?.ReceivedPackets ?? 0):N0}";
        MouseStatusDot.Fill = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        MouseConnectionText.Text = connected ? "Input active" : running ? "Server ready" : "Offline";
        MouseConnectionText.Foreground = connected ? onlineBrush : running ? neutralBrush : offlineBrush;
        MouseInputCountText.Text = $"Input packets received: {(_host?.ReceivedPackets ?? 0):N0}";
        RefreshDiagnostics();
    }

    private void RefreshDiagnostics_Click(object sender, RoutedEventArgs e) => RefreshDiagnostics();

    private void RefreshDiagnostics()
    {
        var address = GetLocalIPv4();
        DiagnosticAddress.Text = address ?? "No active IPv4 address";
        DiagnosticNetworkState.Text = address is null ? "OFFLINE" : "AVAILABLE";
        DiagnosticNetworkState.Foreground = address is null ? Brushes.Firebrick : Brushes.ForestGreen;
        DiagnosticListener.Text = _host?.IsRunning == true ? $"Listening on 0.0.0.0:{WebSocketHost.Port}" : "Listener is stopped";
        DiagnosticListenerState.Text = _host?.IsRunning == true ? "RUNNING" : "STOPPED";
        DiagnosticListenerState.Foreground = _host?.IsRunning == true ? Brushes.ForestGreen : Brushes.Firebrick;
        if (_gamepad?.IsAvailable == true)
        {
            DiagnosticDriver.Text = "Virtual Xbox 360 controller initialized";
            DiagnosticDriverState.Text = "READY";
            DiagnosticDriverState.Foreground = Brushes.ForestGreen;
            GamepadStatus.Text = "Ready";
            GamepadExplanation.Text = "The virtual controller is available to Windows games. Confirm it with joy.cpl if a game does not detect it.";
        }
        else if (_gamepad is not null)
        {
            DiagnosticDriver.Text = _gamepad.InitializationError ?? "ViGEmBus unavailable";
            DiagnosticDriverState.Text = "MISSING";
            DiagnosticDriverState.Foreground = Brushes.Firebrick;
            GamepadStatus.Text = "Driver unavailable";
            GamepadExplanation.Text = "Install ViGEmBus to expose the virtual Xbox controller. Desktop keyboard and mouse control can still work.";
        }
        else
        {
            DiagnosticDriver.Text = "Start the server to initialize the controller backend";
            DiagnosticDriverState.Text = "STOPPED";
            DiagnosticDriverState.Foreground = Brushes.Gray;
            GamepadStatus.Text = "Not initialized";
            GamepadExplanation.Text = "Start the connection server. ViGEmBus is required for the virtual gamepad; desktop control does not use it.";
        }
        DiagnosticsFooter.Text = _host?.IsClientConnected == true
            ? $"Connected session · {_host.ReceivedPackets:N0} packets received · last packet {( _host.LastPacketAt?.ToString("HH:mm:ss") ?? "not yet")}."
            : "Diagnostics are local checks. Firewall reachability cannot be confirmed until a phone connects.";
    }

    private void AutoStartServer_Changed(object sender, RoutedEventArgs e)
    {
        if (_loadingSettings) return;
        _settings.AutoStartServer = AutoStartServerCheckBox.IsChecked == true;
        SettingsStatus.Text = "Unsaved change. Select Save settings to keep it.";
    }

    private void SaveSettings_Click(object sender, RoutedEventArgs e)
    {
        _settings.AutoStartServer = AutoStartServerCheckBox.IsChecked == true;
        try
        {
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "V_Control");
            Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder, "settings.json"), JsonSerializer.Serialize(_settings, new JsonSerializerOptions { WriteIndented = true }));
            SettingsStatus.Text = "Saved locally.";
            Log($"Settings saved (auto-start listener: {_settings.AutoStartServer})");
        }
        catch (Exception ex)
        {
            SettingsStatus.Text = "Could not save settings.";
            Log($"Settings save failed: {ex.Message}", true);
            MessageBox.Show(ex.Message, "Save settings", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void LoadSettings()
    {
        try
        {
            var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "V_Control", "settings.json");
            if (File.Exists(path)) _settings = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(path)) ?? new AppSettings();
        }
        catch (Exception ex) { Log($"Could not load settings: {ex.Message}", true); }
        _loadingSettings = true;
        AutoStartServerCheckBox.IsChecked = _settings.AutoStartServer;
        _loadingSettings = false;
    }

    private void ReleaseInput_Click(object sender, RoutedEventArgs e)
    {
        _gamepad?.Reset();
        _desktopInput?.ReleaseAll();
        Log("Manual safety reset: all held input released");
        SetHomeStatus("All held input was released.");
    }

    private void TestGamepadButton_Down(object sender, MouseButtonEventArgs e)
    {
        if (_gamepad?.IsAvailable != true || sender is not Button button) return;
        var key = button.Content?.ToString() ?? "A";
        try { _gamepad.Apply(new InputMessage("input", new[] { key }, new Dictionary<string, double>())); }
        catch (Exception ex) { Log($"Gamepad test failed: {ex.Message}", true); }
        e.Handled = true;
    }

    private void TestGamepadButton_Up(object sender, MouseButtonEventArgs e)
    {
        _gamepad?.Reset();
        e.Handled = true;
    }

    private void ClearLogs_Click(object sender, RoutedEventArgs e)
    {
        _logs.Clear();
        Log("Log cleared by user");
    }

    private void ExportLogs_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new SaveFileDialog { Title = "Export V_Control logs", Filter = "Text file (*.txt)|*.txt|Log file (*.log)|*.log", FileName = $"V_Control-{DateTime.Now:yyyyMMdd-HHmmss}.txt" };
        if (dialog.ShowDialog(this) != true) return;
        try { File.WriteAllLines(dialog.FileName, _logs); Log($"Logs exported to {dialog.FileName}"); }
        catch (Exception ex) { Log($"Log export failed: {ex.Message}", true); MessageBox.Show(ex.Message, "Export logs", MessageBoxButton.OK, MessageBoxImage.Warning); }
    }

    private void SetHomeStatus(string text)
    {
        HomeStatus.Text = text;
        PairingPageStatus.Text = text;
        FooterStatus.Text = text.Length > 70 ? text[..70] + "…" : text;
    }

    private void SetStatusFromAnyThread(string text)
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(new Action(() => SetStatusFromAnyThread(text))); return; }
        SetHomeStatus(text);
        Log(text, text.Contains("error", StringComparison.OrdinalIgnoreCase) || text.Contains("fail", StringComparison.OrdinalIgnoreCase));
    }

    private void SetConnectedFromAnyThread(bool connected)
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(new Action(() => SetConnectedFromAnyThread(connected))); return; }
        if (connected)
        {
            _pairingExpiresAt = null;
            PairingQrImage.Source = null;
            PairingQrImage.Visibility = Visibility.Collapsed;
            QrEmptyState.Visibility = Visibility.Visible;
            PairingQrImageLarge.Source = null;
            PairingQrImageLarge.Visibility = Visibility.Collapsed;
            QrEmptyStateLarge.Visibility = Visibility.Visible;
            PairingCodeText.Text = "PAIR CODE  ·  USED";
            PairingExpiryText.Text = "Code accepted · single-use code consumed";
            PairingCodeTextLarge.Text = "Code accepted";
            PairingExpiryTextLarge.Text = "Single-use code consumed";
        }
        SetHomeStatus(connected
            ? "Phone connected. Gamepad and desktop-control input will be forwarded to Windows."
            : "Phone disconnected. All held controller, keyboard and mouse inputs have been released. Generate a fresh pairing code to reconnect.");
        Log(connected ? "Phone connected and input stream active" : "Phone disconnected; held input released");
        RefreshLiveStatus();
    }

    private void Log(string message, bool warning = false)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {(warning ? "WARN" : "INFO")}  {message}";
        _logs.Add(line);
        while (_logs.Count > 1000) _logs.RemoveAt(0);
        if (LogList is not null && LogsPage.Visibility == Visibility.Visible && _logs.Count > 0) LogList.ScrollIntoView(_logs[^1]);
    }

    private async void MainWindow_Closed(object? sender, EventArgs e)
    {
        _uiTimer.Stop();
        if (_host is not null) await _host.DisposeAsync();
        _desktopInput?.Dispose();
        _gamepad?.Dispose();
    }

    /// <summary>
    /// Picks the LAN address the phone can actually reach. Prefers adapters with a default gateway,
    /// Wi-Fi/Ethernet, and skips virtual switches (Hyper-V, WSL, VMware, VPN tunnels) that the QR code must not advertise.
    /// </summary>
    private static string? GetLocalIPv4()
    {
        var best = NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up &&
                        n.NetworkInterfaceType != NetworkInterfaceType.Loopback &&
                        n.NetworkInterfaceType != NetworkInterfaceType.Tunnel &&
                        !IsVirtualAdapter(n))
            .Select(n => new
            {
                Nic = n,
                Address = n.GetIPProperties().UnicastAddresses.FirstOrDefault(a =>
                    a.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a.Address) &&
                    !a.Address.ToString().StartsWith("169.254.", StringComparison.Ordinal))?.Address
            })
            .Where(x => x.Address is not null)
            .OrderByDescending(x => x.Nic.GetIPProperties().GatewayAddresses.Any(g =>
                g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any)))
            .ThenBy(x => x.Nic.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? 0
                       : x.Nic.NetworkInterfaceType == NetworkInterfaceType.Ethernet ? 1 : 2)
            .FirstOrDefault();
        return best?.Address?.ToString();
    }

    private static bool IsVirtualAdapter(NetworkInterface network)
    {
        var text = $"{network.Name} {network.Description}";
        return new[] { "virtual", "vEthernet", "Hyper-V", "WSL", "VMware", "VirtualBox", "Pseudo", "Loopback" }
            .Any(keyword => text.Contains(keyword, StringComparison.OrdinalIgnoreCase));
    }

    private sealed class AppSettings
    {
        public bool AutoStartServer { get; set; }
    }
}
