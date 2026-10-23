$ErrorActionPreference = 'Stop'
$mobile = Join-Path $PSScriptRoot '..\WirelessController.Mobile'
Push-Location $mobile
try {
    Write-Host 'Installing JavaScript dependencies…' -ForegroundColor Cyan
    npm install
    Write-Host 'Aligning native packages to the Expo SDK…' -ForegroundColor Cyan
    npx expo install --fix
    Write-Host 'Checking TypeScript…' -ForegroundColor Cyan
    npm run typecheck
    Write-Host 'Running protocol tests…' -ForegroundColor Cyan
    npm run test:protocol
    Write-Host 'Checking Expo app configuration…' -ForegroundColor Cyan
    npx expo-doctor
    Write-Host 'All automated mobile checks completed.' -ForegroundColor Green
} finally { Pop-Location }
