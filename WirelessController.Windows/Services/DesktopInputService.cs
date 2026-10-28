using System.Runtime.InteropServices;

namespace WirelessController.Windows.Services;

/// <summary>Maps the deliberately small mobile desktop-control protocol to Windows SendInput.</summary>
public sealed class DesktopInputService : IDisposable
{
    private const uint InputKeyboard = 1;
    private const uint InputMouse = 0;
    private const uint KeyEventExtended = 0x0001;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;
    private const uint MouseMove = 0x0001;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint MouseRightDown = 0x0008;
    private const uint MouseRightUp = 0x0010;
    private const uint MouseMiddleDown = 0x0020;
    private const uint MouseMiddleUp = 0x0040;
    private const uint MouseWheel = 0x0800;

    private readonly object _gate = new();
    private readonly HashSet<string> _heldKeys = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _heldMouseButtons = new(StringComparer.OrdinalIgnoreCase);
    private bool _disposed;

    private static readonly IReadOnlyDictionary<string, ushort> VirtualKeys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
    {
        ["A"] = 0x41, ["B"] = 0x42, ["C"] = 0x43, ["D"] = 0x44, ["E"] = 0x45,
        ["F"] = 0x46, ["G"] = 0x47, ["H"] = 0x48, ["I"] = 0x49, ["J"] = 0x4A,
        ["K"] = 0x4B, ["L"] = 0x4C, ["M"] = 0x4D, ["N"] = 0x4E, ["O"] = 0x4F,
        ["P"] = 0x50, ["Q"] = 0x51, ["R"] = 0x52, ["S"] = 0x53, ["T"] = 0x54,
        ["U"] = 0x55, ["V"] = 0x56, ["W"] = 0x57, ["X"] = 0x58, ["Y"] = 0x59, ["Z"] = 0x5A,
        ["0"] = 0x30, ["1"] = 0x31, ["2"] = 0x32, ["3"] = 0x33, ["4"] = 0x34,
        ["5"] = 0x35, ["6"] = 0x36, ["7"] = 0x37, ["8"] = 0x38, ["9"] = 0x39,
        ["SPACE"] = 0x20, ["ENTER"] = 0x0D, ["ESC"] = 0x1B, ["ESCAPE"] = 0x1B,
        ["TAB"] = 0x09, ["BACKSPACE"] = 0x08, ["INSERT"] = 0x2D, ["DELETE"] = 0x2E, ["HOME"] = 0x24,
        ["END"] = 0x23, ["PGUP"] = 0x21, ["PGDN"] = 0x22, ["LEFT"] = 0x25,
        ["UP"] = 0x26, ["RIGHT"] = 0x27, ["DOWN"] = 0x28, ["SHIFT"] = 0x10,
        ["CTRL"] = 0x11, ["ALT"] = 0x12, ["WIN"] = 0x5B, ["F1"] = 0x70,
        ["F2"] = 0x71, ["F3"] = 0x72, ["F4"] = 0x73, ["F5"] = 0x74,
        ["F6"] = 0x75, ["F7"] = 0x76, ["F8"] = 0x77, ["F9"] = 0x78,
        ["F10"] = 0x79, ["F11"] = 0x7A, ["F12"] = 0x7B
    };

    public void SetKey(string? key, bool down)
    {
        if (string.IsNullOrWhiteSpace(key) || !VirtualKeys.TryGetValue(key, out var vk)) return;
        lock (_gate)
        {
            ThrowIfDisposed();
            if (down)
            {
                if (!_heldKeys.Add(key)) return;
                Send(new[] { Keyboard(vk, KeyFlagsFor(key)) });
            }
            else
            {
                if (!_heldKeys.Remove(key)) return;
                Send(new[] { Keyboard(vk, KeyFlagsFor(key) | KeyEventKeyUp) });
            }
        }
    }

    public void TypeText(string? text)
    {
        if (string.IsNullOrEmpty(text)) return;
        // A hard cap keeps arbitrary remote messages from generating a large event burst.
        var clipped = text.Length > 240 ? text[..240] : text;
        lock (_gate)
        {
            ThrowIfDisposed();
            var events = new List<INPUT>(clipped.Length * 2);
            foreach (var character in clipped)
            {
                events.Add(Keyboard(0, KeyEventUnicode, character));
                events.Add(Keyboard(0, KeyEventUnicode | KeyEventKeyUp, character));
            }
            Send(events.ToArray());
        }
    }

    public void MoveMouse(int dx, int dy)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            var x = Math.Clamp(dx, -1200, 1200);
            var y = Math.Clamp(dy, -1200, 1200);
            if (x == 0 && y == 0) return;
            Send(new[] { Mouse(x, y, 0, MouseMove) });
        }
    }

    public void SetMouseButton(string? button, bool down)
    {
        if (string.IsNullOrWhiteSpace(button)) return;
        var name = button.ToUpperInvariant();
        var flags = name switch
        {
            "LEFT" => (Down: MouseLeftDown, Up: MouseLeftUp),
            "RIGHT" => (Down: MouseRightDown, Up: MouseRightUp),
            "MIDDLE" => (Down: MouseMiddleDown, Up: MouseMiddleUp),
            _ => (Down: 0u, Up: 0u)
        };
        if (flags.Down == 0) return;
        lock (_gate)
        {
            ThrowIfDisposed();
            if (down)
            {
                if (!_heldMouseButtons.Add(name)) return;
                Send(new[] { Mouse(0, 0, 0, flags.Down) });
            }
            else
            {
                if (!_heldMouseButtons.Remove(name)) return;
                Send(new[] { Mouse(0, 0, 0, flags.Up) });
            }
        }
    }

    public void Scroll(int delta)
    {
        if (delta == 0) return;
        lock (_gate)
        {
            ThrowIfDisposed();
            Send(new[] { Mouse(0, 0, (uint)(short)Math.Clamp(delta, -1200, 1200), MouseWheel) });
        }
    }

    public void ReleaseAll()
    {
        lock (_gate)
        {
            if (_disposed) return;
            var events = new List<INPUT>();
            foreach (var key in _heldKeys)
                if (VirtualKeys.TryGetValue(key, out var vk)) events.Add(Keyboard(vk, KeyFlagsFor(key) | KeyEventKeyUp));
            foreach (var button in _heldMouseButtons)
            {
                var flag = button switch { "LEFT" => MouseLeftUp, "RIGHT" => MouseRightUp, "MIDDLE" => MouseMiddleUp, _ => 0u };
                if (flag != 0) events.Add(Mouse(0, 0, 0, flag));
            }
            _heldKeys.Clear();
            _heldMouseButtons.Clear();
            // Release paths run from disconnect, watchdog and shutdown code. They must never throw,
            // otherwise connection state and the safety watchdog can be left in an inconsistent state.
            if (events.Count > 0) TrySend(events.ToArray());
        }
    }

    private static uint KeyFlagsFor(string key) => key.ToUpperInvariant() switch
    {
        "LEFT" or "UP" or "RIGHT" or "DOWN" or "INSERT" or "DELETE" or "HOME" or "END" or "PGUP" or "PGDN" or "WIN" => KeyEventExtended,
        _ => 0
    };

    private static INPUT Keyboard(ushort vk, uint flags, ushort scan = 0) => new()
    {
        Type = InputKeyboard,
        Data = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = vk, Scan = scan, Flags = flags, Time = 0, ExtraInfo = IntPtr.Zero } }
    };

    private static INPUT Mouse(int dx, int dy, uint data, uint flags) => new()
    {
        Type = InputMouse,
        Data = new InputUnion { Mouse = new MouseInput { Dx = dx, Dy = dy, Data = data, Flags = flags, Time = 0, ExtraInfo = IntPtr.Zero } }
    };

    private static void Send(INPUT[] inputs)
    {
        if (!TrySend(inputs))
            throw new InvalidOperationException("Windows could not inject all requested input events. Try running the app at the same privilege level as the target application.");
    }

    /// <summary>Injects events without throwing. Returns false when Windows blocked some or all of them (e.g. UIPI).</summary>
    private static bool TrySend(INPUT[] inputs)
    {
        if (inputs.Length == 0) return true;
        try
        {
            var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
            return sent == inputs.Length;
        }
        catch (Exception)
        {
            // P/Invoke failures must not escape release paths either.
            return false;
        }
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(DesktopInputService));
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            ReleaseAll();
            _disposed = true;
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint numberOfInputs, INPUT[] inputs, int sizeOfInput);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int Dx; public int Dy; public uint Data; public uint Flags; public uint Time; public IntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput { public ushort VirtualKey; public ushort Scan; public uint Flags; public uint Time; public IntPtr ExtraInfo; }
}
