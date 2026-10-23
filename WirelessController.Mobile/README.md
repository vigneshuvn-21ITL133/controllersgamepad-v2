# V_Control Mobile

Expo/React Native controller for the V_Control Windows companion.

## Features

- Scan the pairing QR with Expo Camera, or enter the PC IPv4 address and six-digit code.
- Gamepad screen with two touch sticks, D-pad, A/B/X/Y or PlayStation-style icons, bumpers, triggers, Start/Back, and stick clicks, with Xbox/PlayStation label selection.
- Dedicated Keyboard screen with key-down/key-up controls, shortcut keys, and text-send field.
- Dedicated Mouse screen with relative touchpad movement, left/right click, and scrolling.
- More/Profile screen for connection details, saved profiles, and Xbox/PlayStation face labels.
- Live connection indicator and round-trip latency based on ping/pong packets.
- Persistent Balanced, FPS, Racing, and Flight stick profiles with sensitivity and inversion tuning.
- Fixed 30 Hz controller-state heartbeat; Windows releases held input after disconnect or heartbeat timeout.

## Run with Expo Go

Use Node.js 22.13 or newer and Windows PowerShell:

```powershell
npm install
npx expo install --fix
npm run typecheck
npm run test:protocol
npx expo start --clear
```

Open Expo Go on Android and scan the Metro QR code. Keep the phone and PC on the same trusted Wi-Fi. In the mobile app, scan the separate pairing QR displayed by the desktop app.

This project is pinned to Expo SDK 57 (`expo ~57.0.31`, React Native `0.86.3`, React `19.2.3`, and `expo-camera ~57.0.6`). If you change native dependencies, run `npx expo install --fix` and check `npx expo-doctor` so versions remain compatible with SDK 57. Allow the Windows companion on the Private firewall profile for TCP 8557.

## Create an APK

```powershell
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile preview
```

The EAS `preview` profile produces an installable APK. EAS may ask you to link this app to an Expo project before starting its remote build.

## Pairing protocol

First WebSocket message: `{"type":"pair","code":"123456"}`. On successful one-time pairing the desktop replies with `{"type":"paired"}`. Mobile sends `input` state packets and `ping` messages. Desktop control commands use `type: "desktop"` and are restricted to a known key map, bounded relative mouse deltas, mouse buttons, scrolling, and text capped at 240 characters per command.

This uses unencrypted `ws://` on the local network. Do not expose the listener to the internet. Automated protocol unit tests can run with Node.js 22.13 or newer using `npm run test:protocol`; actual camera, touch latency, Windows input injection, and Android packaging still require platform testing.
