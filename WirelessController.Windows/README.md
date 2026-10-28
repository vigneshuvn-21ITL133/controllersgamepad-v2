# V_Control — Windows companion

## Implemented

- WPF dashboard with live connection/driver status and Overview, Devices, Settings, Diagnostics, Virtual gamepad, and Event logs pages.
- QR pairing code with six cryptographically random digits, a five-minute expiry, and single-use consumption; manual connection supported by the mobile app.
- Kestrel WebSocket listener on TCP port `8557`, one active paired phone, packet validation, and a 650 ms input heartbeat safety reset.
- Xbox 360-compatible virtual gamepad output through ViGEmBus. Missing ViGEmBus no longer prevents desktop keyboard/mouse control from starting; the gamepad page explains the driver status.
- Desktop keyboard key-down/up, Unicode text, relative mouse motion, left/right/middle buttons, and wheel scrolling through a narrow Windows `SendInput` service.
- Local auto-start-listener preference, device packet metrics, diagnostics, timestamped logs, export/clear logs, and manual input release.
- Connection shutdown/disconnect releases held gamepad, keyboard, and mouse inputs.

## Requirements

- Windows 10/11 and .NET 8 SDK.
- ViGEmBus for the virtual Xbox 360 controller; desktop input does not depend on it.
- Phone and PC on the same trusted private Wi-Fi network.

## Build and run

Run these in **Windows PowerShell**, from this folder:

```powershell
dotnet restore
dotnet build
dotnet run
```

Allow the app through Windows Defender Firewall for **Private networks only**. If you need a rule, run PowerShell as Administrator:

```powershell
New-NetFirewallRule -DisplayName "V_Control WebSocket (Private)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8557 -Profile Private
```

Remove the rule when no longer required:

```powershell
Remove-NetFirewallRule -DisplayName "V_Control WebSocket (Private)"
```

## WebSocket packet reference

After the `pair`/`paired` handshake, mobile sends controller state at about 30 Hz:

```json
{"type":"input","buttons":["A","LB","UP"],"axes":{"leftX":0.2,"leftY":-0.4,"rightX":0,"rightY":0,"leftTrigger":0,"rightTrigger":0}}
```

The mobile may also send `{"type":"ping","clientTime":<unix-ms>}`; the server answers `pong`. Desktop commands use these forms:

```json
{"type":"desktop","action":"key","key":"SPACE","down":true}
{"type":"desktop","action":"type","text":"Hello from V_Control"}
{"type":"desktop","action":"move","dx":12,"dy":-4}
{"type":"desktop","action":"mouseButton","button":"LEFT","down":true}
{"type":"desktop","action":"scroll","delta":120}
```

The server validates actions against a fixed set. Relative movement/scroll values are bounded; typed text is limited to 240 UTF-16 code units per command. The watchdog releases all held input after 650 ms without input/desktop activity and on socket disconnect.

## Safety notes

V_Control is a LAN prototype and uses unencrypted `ws://`. Never port-forward the listener or expose it to public/untrusted networks. Windows may block synthetic input to elevated programs, secure desktop prompts, or anti-cheat-protected games. ViGEmBus is a third-party driver; run `joy.cpl` to verify the virtual device.

This source was reviewed and XML-checked in a Linux environment, but a native WPF/.NET build and real input injection test need to be run on Windows with the .NET SDK installed.
