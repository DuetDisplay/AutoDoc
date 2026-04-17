#Requires -Version 5.1
<#
  Smoke tests for Windows installed-copy policy.
  Verifies single instance, same-version redirect, upgrade/downgrade prompts, and quit behavior.

  ── Prerequisites ─────────────────────────────────────────────────────────

  You need two local builds with different version numbers.  Pick the current
  version from package.json (the "newer" one) and one version below it (the
  "older" one).  For example if package.json says 0.1.8:

    $Stamp = Get-Date -Format "HHmmss"      # e.g. "142305"

    npx electron-vite build                  # compile JS once

    # Older version (0.1.7)
    npx electron-builder --win --publish never `
      "-c.forceCodeSigning=false" "-c.win.signAndEditExecutable=false" `
      "-c.extraMetadata.version=0.1.7" "-c.directories.output=build-older-$Stamp"

    # Newer / current version (0.1.8)
    npx electron-builder --win --publish never `
      "-c.forceCodeSigning=false" "-c.win.signAndEditExecutable=false" `
      "-c.extraMetadata.version=0.1.8" "-c.directories.output=build-newer-$Stamp"

  Then run:
    $env:AUTODOC_SMOKE_STAMP = $Stamp
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-install-policy-smoke.ps1

  ── Environment variables ─────────────────────────────────────────────────

    AUTODOC_SMOKE_STAMP     Build folder suffix (required; no default)
    AUTODOC_SMOKE_OLDER     Older version string  (default: read from package.json, patch - 1)
    AUTODOC_SMOKE_NEWER     Newer version string  (default: read from package.json)

  The script expects under the repo root:
    build-older-<STAMP>\autodoc-<OLDER>-setup.exe   (installer)
    build-newer-<STAMP>\autodoc-<NEWER>-setup.exe   (installer)
    build-older-<STAMP>\win-unpacked\autodoc.exe    (loose copy)
    build-newer-<STAMP>\win-unpacked\autodoc.exe    (loose copy)

  After the run, build-older-<STAMP> and build-newer-<STAMP> under the repo are deleted.
#>
$ErrorActionPreference = 'Stop'

# ─── Resolve versions ──────────────────────────────────────────────────────

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$Stamp = $env:AUTODOC_SMOKE_STAMP
if ([string]::IsNullOrWhiteSpace($Stamp)) {
  throw "Set `$env:AUTODOC_SMOKE_STAMP to the suffix of your build-older-* / build-newer-* folders before running."
}

function Get-PackageJsonVersion {
  $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
  return $pkg.version
}

function Get-PreviousPatchVersion([string]$Version) {
  $parts = $Version -split '\.'
  if ($parts.Count -lt 3) { throw "Cannot derive previous patch from version '$Version'" }
  $patch = [int]$parts[-1]
  if ($patch -le 0) { throw "Patch is already 0 for version '$Version' - set AUTODOC_SMOKE_OLDER explicitly" }
  $parts[-1] = [string]($patch - 1)
  return $parts -join '.'
}

$NewerVersion = $env:AUTODOC_SMOKE_NEWER
if ([string]::IsNullOrWhiteSpace($NewerVersion)) { $NewerVersion = Get-PackageJsonVersion }
$OlderVersion = $env:AUTODOC_SMOKE_OLDER
if ([string]::IsNullOrWhiteSpace($OlderVersion)) { $OlderVersion = Get-PreviousPatchVersion $NewerVersion }

Write-Host "Smoke test: older=$OlderVersion  newer=$NewerVersion  stamp=$Stamp" -ForegroundColor Cyan

# ─── Paths ─────────────────────────────────────────────────────────────────

$SetupOlder = Join-Path $RepoRoot "build-older-$Stamp\autodoc-$OlderVersion-setup.exe"
$SetupNewer = Join-Path $RepoRoot "build-newer-$Stamp\autodoc-$NewerVersion-setup.exe"
$LooseOlder = Join-Path $RepoRoot "build-older-$Stamp\win-unpacked\autodoc.exe"
$LooseNewer = Join-Path $RepoRoot "build-newer-$Stamp\win-unpacked\autodoc.exe"
$InstalledDir = Join-Path $env:LOCALAPPDATA 'Programs\autodoc'
$InstalledExe = Join-Path $InstalledDir 'autodoc.exe'
$UserDataDir = Join-Path $env:TEMP "autodoc-smoke-user-data-$Stamp"
$UserDataMarker = Join-Path $UserDataDir 'models\uninstall-smoke-marker.bin'
$env:AUTODOC_TEST_USER_DATA_DIR = $UserDataDir

# ─── Win32 dialog detection ───────────────────────────────────────────────

Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
Add-Type -AssemblyName System.Windows.Forms | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class NativePolicyDialog {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  public static IntPtr FoundHwnd = IntPtr.Zero;

  public static bool EnumHandler(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd)) return true;
    var sb = new StringBuilder(600);
    GetWindowText(hWnd, sb, sb.Capacity);
    var title = sb.ToString();
    if (string.IsNullOrEmpty(title)) return true;
    if (title.IndexOf("Upgrade Installed Copy", StringComparison.OrdinalIgnoreCase) >= 0
        || title.IndexOf("Downgrade Installed Copy", StringComparison.OrdinalIgnoreCase) >= 0
        || title.IndexOf("Replace Installed Copy", StringComparison.OrdinalIgnoreCase) >= 0) {
      FoundHwnd = hWnd;
      return false;
    }
    return true;
  }

  public static IntPtr FindHwnd() {
    FoundHwnd = IntPtr.Zero;
    EnumWindows(EnumHandler, IntPtr.Zero);
    return FoundHwnd;
  }
}
'@

# ─── Helpers ────────────────────────────────────────────────────────────────

function Write-Step { param([string]$Msg) Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }

function Assert-File { param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing $Label : $Path" }
}

function Stop-AllAutodoc {
  Get-CimInstance Win32_Process -Filter "Name = 'autodoc.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Get-InstanceRootCount {
  $all = @(Get-CimInstance Win32_Process -Filter "Name = 'autodoc.exe'" -ErrorAction SilentlyContinue)
  if ($all.Count -eq 0) { return 0 }
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($p in $all) { [void]$ids.Add([int]$p.ProcessId) }
  return @($all | Where-Object { -not $ids.Contains([int]$_.ParentProcessId) }).Count
}

function Get-InstalledVersion {
  $asarPath = Join-Path $InstalledDir 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $asarPath)) { return $null }
  $nodeScript = @"
const asar = require('@electron/asar');
const buf = asar.extractFile(process.argv[1], 'package.json');
const j = JSON.parse(buf.toString());
process.stdout.write(j.version || '');
"@
  try {
    Push-Location $RepoRoot
    $ver = & node -e $nodeScript $asarPath 2>$null
    return $ver
  } catch {
    return $null
  } finally {
    Pop-Location
  }
}

function Install-Silent {
  param([string]$InstallerPath)
  Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait | Out-Null
  Start-Sleep -Seconds 4
}

function Uninstall-Silent {
  $entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'AutoDoc*' } | Select-Object -First 1
  if (-not $entry) { return }
  $quiet = $entry.QuietUninstallString
  if ($quiet) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $quiet -Wait
  } elseif ($entry.UninstallString) {
    $cmd = $entry.UninstallString
    if ($cmd -notmatch '(?i)/S(\s|$)') { $cmd = "$cmd /S" }
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -Wait
  }
  Start-Sleep -Seconds 4
}

function Uninstall-WithDeleteAppData {
  $entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'AutoDoc*' } | Select-Object -First 1
  if (-not $entry) { return }
  if ($entry.QuietUninstallString) {
    $cmd = "$($entry.QuietUninstallString) --delete-app-data"
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -Wait
  } elseif ($entry.UninstallString) {
    $cmd = $entry.UninstallString
    if ($cmd -notmatch '(?i)/S(\s|$)') { $cmd = "$cmd /S" }
    $cmd = "$cmd --delete-app-data"
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -Wait
  }
  Start-Sleep -Seconds 4
}

function Seed-SmokeLocalData {
  New-Item -ItemType Directory -Force -Path (Split-Path $UserDataMarker -Parent) | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $UserDataDir 'recordings\meeting-1') | Out-Null
  Set-Content -LiteralPath $UserDataMarker -Value 'autodoc smoke marker' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $UserDataDir 'recordings\meeting-1\audio.webm') -Value 'recording marker' -Encoding utf8
}

function Clear-SmokeLocalData {
  if (Test-Path -LiteralPath $UserDataDir) {
    Remove-Item -LiteralPath $UserDataDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Send-Dialog {
  param(
    [ValidateSet('Accept','Quit')][string]$Choice = 'Accept',
    [int]$TimeoutSec = 60,
    [switch]$Quiet
  )
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    $hwnd = [NativePolicyDialog]::FindHwnd()
    if ($hwnd -ne [IntPtr]::Zero) {
      [void][NativePolicyDialog]::SetForegroundWindow($hwnd)
      Start-Sleep -Milliseconds 500
      if ($Choice -eq 'Accept') {
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      } else {
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
      }
      Start-Sleep -Milliseconds 800
      return $true
    }
    Start-Sleep -Milliseconds 400
  }
  if (-not $Quiet) {
    Write-Host "       (no dialog found within ${TimeoutSec}s)" -ForegroundColor DarkYellow
  }
  return $false
}

function Wait-InstanceCount {
  param([int]$Expected, [int]$TimeoutSec = 90)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if ((Get-InstanceRootCount) -eq $Expected) { return }
    Start-Sleep -Milliseconds 500
  }
  $n = Get-InstanceRootCount
  throw "Expected $Expected instance(s), got $n after ${TimeoutSec}s"
}

# ─── Pre-checks (inside try so finally can remove build dirs on failure) ───

$results = [System.Collections.Generic.List[object]]::new()
function Record {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  $results.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
  Write-Host ("[{0}] {1}" -f $(if ($Ok) {'PASS'} else {'FAIL'}), $Name) -ForegroundColor $(if ($Ok) {'Green'} else {'Red'})
  if ($Detail) { Write-Host "       $Detail" -ForegroundColor DarkGray }
}

# ─── Tests ──────────────────────────────────────────────────────────────────

try {
  Assert-File $SetupOlder "$OlderVersion installer"
  Assert-File $SetupNewer "$NewerVersion installer"
  Assert-File $LooseOlder "$OlderVersion loose"
  Assert-File $LooseNewer "$NewerVersion loose"

  Write-Step 'Cleanup'
  Stop-AllAutodoc
  Uninstall-Silent

  # 1 ── Single launch
  Write-Step "1) Install $NewerVersion, launch installed - opens normally"
  Install-Silent $SetupNewer
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 6
  $c = Get-InstanceRootCount
  Record '1 installed launch' ($c -eq 1) "instances: $c"
  Stop-AllAutodoc

  # 2 ── Double launch
  Write-Step '2) Launch installed twice - single instance'
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 6
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 4
  $c2 = Get-InstanceRootCount
  Record '2 single instance' ($c2 -eq 1) "instances: $c2"
  Stop-AllAutodoc

  # 3a ── Same-version loose cold - redirects to installed copy
  Write-Step '3a) Same-version loose when not running - redirects to installed, no dialog'
  Start-Process -FilePath $LooseNewer | Out-Null
  Start-Sleep -Seconds 12
  $dlg = Send-Dialog -Choice Accept -TimeoutSec 3 -Quiet
  $c3 = Get-InstanceRootCount
  $runningFromInstalled = $false
  if ($c3 -ge 1) {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'autodoc.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath })
    foreach ($p in $procs) {
      if ($p.ExecutablePath -and $p.ExecutablePath.ToLower().StartsWith($InstalledDir.ToLower())) {
        $runningFromInstalled = $true
        break
      }
    }
  }
  Stop-AllAutodoc
  Record '3a same-ver loose cold redirect' ((-not $dlg) -and ($c3 -eq 1) -and $runningFromInstalled) "dialog: $dlg, instances: $c3, from installed: $runningFromInstalled"

  # 3b ── Same-version loose warm
  Write-Step '3b) Same-version loose while running - focus, no dialog'
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 6
  Start-Process -FilePath $LooseNewer | Out-Null
  Start-Sleep -Seconds 6
  $dlg3b = Send-Dialog -Choice Accept -TimeoutSec 4 -Quiet
  $c3b = Get-InstanceRootCount
  Stop-AllAutodoc
  Record '3b same-ver loose warm' ((-not $dlg3b) -and ($c3b -eq 1)) "dialog: $dlg3b, instances: $c3b"

  # 4 ── Upgrade cold
  Write-Step "4) Upgrade: install $OlderVersion, loose $NewerVersion cold - accept"
  Uninstall-Silent
  Install-Silent $SetupOlder
  $vPre = Get-InstalledVersion
  Start-Process -FilePath $LooseNewer | Out-Null
  Start-Sleep -Seconds 12
  $ok4 = Send-Dialog -Choice Accept -TimeoutSec 90
  if (-not $ok4) { throw 'Upgrade dialog not found' }
  Wait-InstanceCount -Expected 1 -TimeoutSec 120
  Start-Sleep -Seconds 8
  $vPost = Get-InstalledVersion
  Stop-AllAutodoc
  Record '4 upgrade cold accept' ($vPost -eq $NewerVersion) "version: $vPre -> $vPost"

  # 5 ── Downgrade cold
  Write-Step "5) Downgrade: install $NewerVersion, loose $OlderVersion cold - accept"
  Uninstall-Silent
  Install-Silent $SetupNewer
  $vPre5 = Get-InstalledVersion
  Start-Process -FilePath $LooseOlder | Out-Null
  Start-Sleep -Seconds 12
  $ok5 = Send-Dialog -Choice Accept -TimeoutSec 90
  if (-not $ok5) { throw 'Downgrade dialog not found' }
  Wait-InstanceCount -Expected 1 -TimeoutSec 120
  Start-Sleep -Seconds 8
  $vPost5 = Get-InstalledVersion
  Stop-AllAutodoc
  Record '5 downgrade cold accept' ($vPost5 -eq $OlderVersion) "version: $vPre5 -> $vPost5"

  # 6 ── Upgrade warm
  Write-Step "6) Upgrade warm: install $OlderVersion running + loose $NewerVersion - accept"
  Uninstall-Silent
  Install-Silent $SetupOlder
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 8
  Start-Process -FilePath $LooseNewer | Out-Null
  Start-Sleep -Seconds 10
  $ok6 = Send-Dialog -Choice Accept -TimeoutSec 90
  if (-not $ok6) { throw 'Upgrade warm dialog not found' }
  Wait-InstanceCount -Expected 1 -TimeoutSec 120
  Start-Sleep -Seconds 8
  $v6 = Get-InstalledVersion
  Stop-AllAutodoc
  Record '6 upgrade warm accept' ($v6 -eq $NewerVersion) "version: $v6"

  # 7 ── Downgrade warm
  Write-Step "7) Downgrade warm: install $NewerVersion running + loose $OlderVersion - accept"
  Uninstall-Silent
  Install-Silent $SetupNewer
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 8
  Start-Process -FilePath $LooseOlder | Out-Null
  Start-Sleep -Seconds 10
  $ok7 = Send-Dialog -Choice Accept -TimeoutSec 90
  if (-not $ok7) { throw 'Downgrade warm dialog not found' }
  Wait-InstanceCount -Expected 1 -TimeoutSec 120
  Start-Sleep -Seconds 8
  $v7 = Get-InstalledVersion
  Stop-AllAutodoc
  Record '7 downgrade warm accept' ($v7 -eq $OlderVersion) "version: $v7"

  # 8 ── Quit on upgrade
  Write-Step '8) Upgrade quit - installed unchanged, loose exits'
  Uninstall-Silent
  Install-Silent $SetupOlder
  $v8pre = Get-InstalledVersion
  $p8 = Start-Process -FilePath $LooseNewer -PassThru
  Start-Sleep -Seconds 10
  $q8 = Send-Dialog -Choice Quit -TimeoutSec 90
  if (-not $q8) { throw 'Upgrade quit dialog not found' }
  Start-Sleep -Seconds 6
  $v8post = Get-InstalledVersion
  $alive = Get-Process -Id $p8.Id -ErrorAction SilentlyContinue
  $n8 = Get-InstanceRootCount
  Stop-AllAutodoc
  Record '8 upgrade quit' (($v8post -eq $v8pre) -and (-not $alive) -and ($n8 -eq 0)) "version: $v8pre -> $v8post, loose alive: $($null -ne $alive), instances: $n8"

  # 9 ── Quit on downgrade
  Write-Step '9) Downgrade quit - installed unchanged, loose exits'
  Uninstall-Silent
  Install-Silent $SetupNewer
  $v9pre = Get-InstalledVersion
  $p9 = Start-Process -FilePath $LooseOlder -PassThru
  Start-Sleep -Seconds 10
  $q9 = Send-Dialog -Choice Quit -TimeoutSec 90
  if (-not $q9) { throw 'Downgrade quit dialog not found' }
  Start-Sleep -Seconds 6
  $v9post = Get-InstalledVersion
  $alive9 = Get-Process -Id $p9.Id -ErrorAction SilentlyContinue
  $n9 = Get-InstanceRootCount
  Stop-AllAutodoc
  Record '9 downgrade quit' (($v9post -eq $v9pre) -and (-not $alive9) -and ($n9 -eq 0)) "version: $v9pre -> $v9post, loose alive: $($null -ne $alive9), instances: $n9"

  # 10 ── Default uninstall keeps local data
  Write-Step '10) Silent uninstall keeps local AutoDoc data by default'
  Uninstall-Silent
  Install-Silent $SetupNewer
  Seed-SmokeLocalData
  Uninstall-Silent
  $appRemoved10 = -not (Test-Path -LiteralPath $InstalledExe)
  $markerPresent10 = Test-Path -LiteralPath $UserDataMarker
  Record '10 uninstall keeps local data' ($appRemoved10 -and $markerPresent10) "installed exe present: $(-not $appRemoved10), local data marker present: $markerPresent10"
  Clear-SmokeLocalData

  # 11 ── Uninstall with explicit delete flag removes local data
  Write-Step '11) Silent uninstall with delete flag removes local AutoDoc data'
  Install-Silent $SetupNewer
  Seed-SmokeLocalData
  Uninstall-WithDeleteAppData
  $appRemoved11 = -not (Test-Path -LiteralPath $InstalledExe)
  $markerPresent11 = Test-Path -LiteralPath $UserDataMarker
  Record '11 uninstall delete-app-data removes local data' ($appRemoved11 -and (-not $markerPresent11)) "installed exe present: $(-not $appRemoved11), local data marker present: $markerPresent11"
}
catch {
  Write-Host "FATAL: $_" -ForegroundColor Red
  throw
}
finally {
  Write-Step 'Final cleanup'
  Stop-AllAutodoc
  Clear-SmokeLocalData
  Remove-Item Env:AUTODOC_TEST_USER_DATA_DIR -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace($Stamp)) {
    foreach ($rel in @("build-older-$Stamp", "build-newer-$Stamp")) {
      $buildDir = Join-Path $RepoRoot $rel
      if (Test-Path -LiteralPath $buildDir) {
        Remove-Item -LiteralPath $buildDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Removed smoke build: $buildDir" -ForegroundColor DarkGray
      }
    }
  }
}

Write-Host "`n=== Summary ===" -ForegroundColor Yellow
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { -not $_.Ok }).Count
Write-Host "Result: $($results.Count - $failed)/$($results.Count) passed" -ForegroundColor $(if ($failed -eq 0) {'Green'} else {'Red'})
if ($failed -gt 0) { exit 1 }
exit 0
