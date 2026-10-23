# V_Control

V_Control turns an Android phone into a wireless Windows gamepad and desktop remote. The repository contains a WPF/.NET 8 Windows companion and an Expo/React Native mobile app.

## Features

- One-time, six-digit QR/manual pairing over a local WebSocket on TCP `8557`.
- Xbox 360-compatible virtual gamepad through ViGEmBus, including face buttons, D-pad, bumpers, triggers, and both analog sticks.
- Mobile desktop mode with touchpad mouse movement, left/right click, scroll, on-screen keyboard, shortcut keys, and text entry.
- Four mobile control profiles (Balanced, FPS, Racing, Flight), saved locally across app restarts.
- Coordinated silver/white/graphite UI on Windows and Android; green is reserved for connected/active status and red for disconnected/error states.
- Windows dashboard, pairing, gamepad, keyboard, mouse, diagnostics, settings, and logs screens, plus a draggable custom title bar with minimize/maximize/restore/close buttons.
- Android bottom navigation separates Gamepad, Keyboard, Mouse, and More/Profile screens.
- Input heartbeat safety reset: held keyboard/mouse/gamepad input is released when the connection drops or input heartbeats stop.
- Desktop settings, diagnostics, device session metrics, and timestamped logs with export.

## Requirements

- Windows 10/11 and the .NET 8 SDK.
- ViGEmBus installed if virtual gamepad output is needed. The WebSocket server and desktop mouse/keyboard mode can still start if that driver is unavailable.
- Node.js 22.13 or newer recommended for the mobile app, npm, and an Android phone with a compatible Expo Go app (or an Android build from EAS).
- Phone and PC on the same trusted private Wi-Fi network. Guest-network client isolation can block the connection.

## Run the Windows companion

Open **Windows PowerShell** in `WirelessController.Windows`:

```powershell
dotnet restore
dotnet build
dotnet run
```

Start the listener in V_Control. Allow TCP `8557` through Windows Defender Firewall only on **Private** networks. If necessary, an administrator can add the narrow rule:

```powershell
New-NetFirewallRule -DisplayName "V_Control WebSocket (Private)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8557 -Profile Private
```

Remove it when you no longer need it:

```powershell
Remove-NetFirewallRule -DisplayName "V_Control WebSocket (Private)"
```

## Run the mobile app

Open a second PowerShell window in `WirelessController.Mobile`:

```powershell
npm install
npx expo install --fix
npm run typecheck
npm run test:protocol
npx expo start --clear
```

Open the matching Expo Go app on Android and scan the Metro QR code. Inside V_Control Mobile, scan the pairing QR displayed by the Windows companion. Manual pairing accepts the PC's IPv4 address (optionally `:8557`) and the six-digit code.

## Build an installable Android APK

After installing dependencies and configuring an Expo/EAS account:

```powershell
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile preview
```

The `preview` profile in `WirelessController.Mobile/eas.json` is configured for an APK. EAS will provide the build artifact link when its remote build finishes. If `app.json` has not yet been associated with an EAS project, follow the configuration prompt and let EAS write the generated project ID.

## Safety and limitations

- V_Control is a trusted-LAN utility, not an internet-facing service. The WebSocket transport is unencrypted `ws://`; do not port-forward it or use it on public/untrusted networks.
- Pairing codes expire after five minutes and are single-use. Only one active phone may control the PC.
- Desktop control injects ordinary Windows input. Elevated apps, UAC/secure desktop, anti-cheat software, and some games may ignore synthetic input; V_Control cannot bypass those boundaries.
- ViGEmBus is a third-party driver requirement for gamepad output. Confirm the virtual controller with `joy.cpl` on Windows when needed.
- This repository was edited and its protocol tests were run in a Linux build environment. A Windows .NET build and a real Android/Expo runtime test were not possible in that environment because the .NET SDK and mobile npm packages could not be installed there. Follow the platform-specific commands above before relying on it.


## Validation performed on this source snapshot

- `npm run test:protocol`: 7 of 7 protocol tests pass in Node.js, including the SDK 57 pin.
- Mobile TypeScript: TSX syntax and a temporary-declaration type pass succeeded; rerun `npm run typecheck` after installing the actual Expo dependencies.
- Windows XAML: both XAML files parse, all XAML event handlers are defined, code-behind control references match the XAML names, and static resource references are present.
- Mobile configuration JSON parses successfully.
- **Not verified in this environment:** a native .NET Windows build, an Expo bundle, live WebSocket pairing between devices, ViGEmBus output, mouse/keyboard injection on Windows, or a generated APK. Use the platform build/run instructions above to perform these integration tests.

## QR generation crash diagnostics

The QR crash hotfix records unexpected WPF, app-domain and background-task exceptions to `%LOCALAPPDATA%\V_Control\crash.log`. If the window still closes, run `Get-Content "$env:LOCALAPPDATA\V_Control\crash.log" -Tail 100` in PowerShell and share the output.

## UI update (silver edition)

The actual Windows XAML page layouts and Android Expo screen navigation have been redesigned to match the approved concept, rather than changing the palette alone. The Windows sidebar has Dashboard, Pairing, Gamepad, Keyboard, Mouse, Diagnostics, Settings, and Logs. Android has separate Gamepad, Keyboard, Mouse, and More/Profile tabs. The custom Windows title bar supports dragging, minimize, maximize/restore, and close. Green is used for connected/active states; neutral silver/graphite is used for navigation and controls; red denotes disconnected/error states.


**Mobile SDK compatibility:** The mobile project targets Expo SDK 57, React Native 0.86.3, and React 19.2.3. Use Node.js 22.13 or newer. Run `npx expo install --fix` and `npx expo-doctor` after installing dependencies.


### Pairing expiry behavior
The PC is authoritative for one-time pairing code expiry (5 minutes). The mobile app validates QR structure but does not compare expiry against the phone clock, avoiding false expiry messages when the phone clock is skewed. The PC still rejects expired or already-used codes. Generate a fresh code on the PC after any failed/previous pairing attempt.


### Pairing troubleshooting (SDK 57 hotfix)

- Start the PC listener and generate a fresh code; it expires after five minutes and can be used once.
- Mobile QR parsing does not reject codes based on the phone clock; the PC is authoritative for expiry.
- Manual pairing accepts six digits with optional spaces or hyphens.
- After updating the mobile source, restart Expo with `npx expo start --clear`. Keep Expo pinned to `~57.0.31`.


## Apply this update to your existing GitHub repository

Do **not** create a new repository and do **not** replace your existing `.git` folder. Extract this ZIP into a temporary folder, then copy the contents of this project over your existing working tree at `D:\vicky\code\application.net\WirelessGameController-main`. Keep `.git`, local-only settings, and any work you have not committed. When Windows asks whether to replace matching source files, replace those project files.

From the existing repository root, review the changes first:

```powershell
git status
git remote -v
git diff --stat
```

Build Windows before committing:

```powershell
dotnet clean .\WirelessController.Windows\WirelessController.Windows.csproj
dotnet build .\WirelessController.Windows\WirelessController.Windows.csproj
dotnet run --project .\WirelessController.Windows\WirelessController.Windows.csproj
```

Then test mobile from `WirelessController.Mobile`:

```powershell
npm install
npm run typecheck
npm run test:protocol
npx expo start --clear
```

Only after reviewing and testing the changes, commit and push to your existing default branch (usually `main`):

```powershell
git add .
git commit -m "Redesign V_Control desktop and mobile UI"
git push origin main
```

If your current branch is not `main`, use the branch name reported by `git branch --show-current`. This archive deliberately does not contain a `.git` directory, so the existing repository connection and commit history remain under your control.
