$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot '..\WirelessController.Windows\WirelessController.Windows.csproj'
Write-Host 'Restoring V_Control Windows dependencies…' -ForegroundColor Cyan
dotnet restore $project
Write-Host 'Building V_Control (Release)…' -ForegroundColor Cyan
dotnet build $project -c Release --no-restore
Write-Host 'Build succeeded. Run with: dotnet run --project "' $project '"' -ForegroundColor Green
