$ErrorActionPreference = 'Stop'
$mobile = Join-Path $PSScriptRoot '..\WirelessController.Mobile'
Push-Location $mobile
try {
    if (-not (Test-Path 'node_modules')) { npm install; npx expo install --fix }
    npm run test:protocol
    npx expo start --lan --clear
} finally { Pop-Location }
