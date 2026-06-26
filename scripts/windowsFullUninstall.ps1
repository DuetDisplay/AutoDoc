$ErrorActionPreference = 'Stop'

Write-Host 'Stopping AutoDoc and managed dependency processes...'
Get-Process autodoc, ollama -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

$paths = @(
  (Join-Path $env:APPDATA 'AutoDoc'),
  (Join-Path $env:APPDATA 'autodoc'),
  (Join-Path $env:LOCALAPPDATA 'autodoc-updater'),
  (Join-Path $env:LOCALAPPDATA 'Programs\AutoDoc'),
  (Join-Path $env:USERPROFILE 'AutoDoc')
)

$removedCount = 0

foreach ($path in $paths) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
    $removedCount += 1
    Write-Host "Removed $path"
  } else {
    Write-Host "Not found $path"
  }
}

Write-Host ''
Write-Host "AutoDoc reset completed successfully. Removed $removedCount path(s). This Windows account is ready for first-time install testing." -ForegroundColor Green
