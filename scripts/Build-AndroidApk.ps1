$ErrorActionPreference = 'Stop'
$mobile = Join-Path $PSScriptRoot '..\WirelessController.Mobile'
Push-Location $mobile
try {
    if (-not (Get-Command eas -ErrorAction SilentlyContinue)) {
        throw 'EAS CLI is not installed. Run: npm install -g eas-cli'
    }
    npm install
    npx expo install --fix
    npm run typecheck
    npm run test:protocol
    npx expo-doctor
    eas build --platform android --profile preview
} finally { Pop-Location }
