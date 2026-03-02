$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionRoot = Resolve-Path (Join-Path $scriptDir "..")
$distPath = Join-Path $extensionRoot "dist"

if (-not (Test-Path $distPath)) {
  throw "Build output not found at $distPath. Run npm run build first."
}

$outputDir = Join-Path $extensionRoot "..\build"
if (-not (Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

$outputZip = Join-Path $outputDir "PinForge-extension.zip"
if (Test-Path $outputZip) {
  Remove-Item $outputZip -Force
}

Compress-Archive -Path (Join-Path $distPath "*") -DestinationPath $outputZip -Force
Write-Output "Created extension package: $outputZip"
