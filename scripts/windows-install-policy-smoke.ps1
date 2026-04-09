#Requires -Version 5.1
<#
  Smoke checks for Windows installed-copy policy (single instance, upgrade/downgrade, redirect).

  Build two versions locally, e.g.:
    npx electron-vite build
    npx electron-builder --win --publish never `
      "-c.forceCodeSigning=false" "-c.win.signAndEditExecutable=false" `
      "-c.extraMetadata.version=0.1.7" "-c.directories.output=build-017-<STAMP>"
    (repeat for 0.1.8 -> build-018-<STAMP>)

  Optional env:
    $env:AUTODOC_SMOKE_STAMP = '<STAMP>'   # default: 165235 — must match your build-* folder suffix

  Expects under repo root:
    build-017-<STAMP>\autodoc-0.1.7-setup.exe
    build-018-<STAMP>\autodoc-0.1.8-setup.exe
    build-017-<STAMP>\win-unpacked\autodoc.exe
    build-018-<STAMP>\win-unpacked\autodoc.exe
#>
$ErrorActionPreference = 'Stop'

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

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Stamp = $env:AUTODOC_SMOKE_STAMP
if ([string]::IsNullOrWhiteSpace($Stamp)) { $Stamp = '165235' }
$Setup017 = Join-Path $RepoRoot "build-017-$Stamp\autodoc-0.1.7-setup.exe"
$Setup018 = Join-Path $RepoRoot "build-018-$Stamp\autodoc-0.1.8-setup.exe"
$Loose017 = Join-Path $RepoRoot "build-017-$Stamp\win-unpacked\autodoc.exe"
$Loose018 = Join-Path $RepoRoot "build-018-$Stamp\win-unpacked\autodoc.exe"
$InstalledDir = Join-Path $env:LOCALAPPDATA 'Programs\autodoc'
$InstalledExe = Join-Path $InstalledDir 'autodoc.exe'

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

# ─── Pre-checks ─────────────────────────────────────────────────────────────

Assert-File $Setup017 '0.1.7 installer'
Assert-File $Setup018 '0.1.8 installer'
Assert-File $Loose017 '0.1.7 loose'
Assert-File $Loose018 '0.1.8 loose'

$results = [System.Collections.Generic.List[object]]::new()
function Record {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  $results.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
  Write-Host ("[{0}] {1}" -f $(if ($Ok) {'PASS'} else {'FAIL'}), $Name) -ForegroundColor $(if ($Ok) {'Green'} else {'Red'})
  if ($Detail) { Write-Host "       $Detail" -ForegroundColor DarkGray }
}

# ─── Tests ──────────────────────────────────────────────────────────────────

try {
  Write-Step 'Cleanup'
  Stop-AllAutodoc
  Uninstall-Silent

  # 1 ── Single launch
  Write-Step '1) Install 0.1.8, launch installed — opens normally'
  Install-Silent $Setup018
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 6
  $c = Get-InstanceRootCount
  Record '1 installed launch' ($c -eq 1) "instances: $c"
  Stop-AllAutodoc

  # 2 ── Double launch
  Write-Step '2) Launch installed twice — single instance'
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 6
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 4
  $c2 = Get-InstanceRootCount
  Record '2 single instance' ($c2 -eq 1) "instances: $c2"
  Stop-AllAutodoc

  # 3a ── Same-version loose cold — redirects to installed copy
  Write-Step '3a) Same-version loose when not running — redirects to installed, no dialog'
  Start-Process -FilePath $Loose018 | Out-Null
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
  Write-Step '3b) Same-version loose while running — focus, no dialog'
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 6
  Start-Process -FilePath $Loose018 | Out-Null
  Start-Sleep -Seconds 6
  $dlg3b = Send-Dialog -Choice Accept -TimeoutSec 4 -Quiet
  $c3b = Get-InstanceRootCount
  Stop-AllAutodoc
  Record '3b same-ver loose warm' ((-not $dlg3b) -and ($c3b -eq 1)) "dialog: $dlg3b, instances: $c3b"

  # 4 ── Upgrade cold
  Write-Step '4) Upgrade: install 0.1.7, loose 0.1.8 cold — accept'
  Uninstall-Silent
  Install-Silent $Setup017
  $vPre = Get-InstalledVersion
  Start-Process -FilePath $Loose018 | Out-Null
  Start-Sleep -Seconds 12
  $ok4 = Send-Dialog -Choice Accept -TimeoutSec 90
  if (-not $ok4) { throw 'Upgrade dialog not found' }
  Wait-InstanceCount -Expected 1 -TimeoutSec 120
  Start-Sleep -Seconds 8
  $vPost = Get-InstalledVersion
  Stop-AllAutodoc
  Record '4 upgrade cold accept' ($vPost -eq '0.1.8') "version: $vPre -> $vPost"

  # 5 ── Downgrade cold
  Write-Step '5) Downgrade: install 0.1.8, loose 0.1.7 cold — accept'
  Uninstall-Silent
  Install-Silent $Setup018
  $vPre5 = Get-InstalledVersion
  Start-Process -FilePath $Loose017 | Out-Null
  Start-Sleep -Seconds 12
  $ok5 = Send-Dialog -Choice Accept -TimeoutSec 90
  if (-not $ok5) { throw 'Downgrade dialog not found' }
  Wait-InstanceCount -Expected 1 -TimeoutSec 120
  Start-Sleep -Seconds 8
  $vPost5 = Get-InstalledVersion
  Stop-AllAutodoc
  Record '5 downgrade cold accept' ($vPost5 -eq '0.1.7') "version: $vPre5 -> $vPost5"

  # 6 ── Upgrade warm
  Write-Step '6) Upgrade warm: install 0.1.7 running + loose 0.1.8 — accept'
  Uninstall-Silent
  Install-Silent $Setup017
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 8
  Start-Process -FilePath $Loose018 | Out-Null
  Start-Sleep -Seconds 10
  $ok6 = Send-Dialog -Choice Accept -TimeoutSec 90
  if (-not $ok6) { throw 'Upgrade warm dialog not found' }
  Wait-InstanceCount -Expected 1 -TimeoutSec 120
  Start-Sleep -Seconds 8
  $v6 = Get-InstalledVersion
  Stop-AllAutodoc
  Record '6 upgrade warm accept' ($v6 -eq '0.1.8') "version: $v6"

  # 7 ── Downgrade warm
  Write-Step '7) Downgrade warm: install 0.1.8 running + loose 0.1.7 — accept'
  Uninstall-Silent
  Install-Silent $Setup018
  Start-Process -FilePath $InstalledExe | Out-Null
  Start-Sleep -Seconds 8
  Start-Process -FilePath $Loose017 | Out-Null
  Start-Sleep -Seconds 10
  $ok7 = Send-Dialog -Choice Accept -TimeoutSec 90
  if (-not $ok7) { throw 'Downgrade warm dialog not found' }
  Wait-InstanceCount -Expected 1 -TimeoutSec 120
  Start-Sleep -Seconds 8
  $v7 = Get-InstalledVersion
  Stop-AllAutodoc
  Record '7 downgrade warm accept' ($v7 -eq '0.1.7') "version: $v7"

  # 8 ── Quit on upgrade
  Write-Step '8) Upgrade quit — installed unchanged, loose exits'
  Uninstall-Silent
  Install-Silent $Setup017
  $v8pre = Get-InstalledVersion
  $p8 = Start-Process -FilePath $Loose018 -PassThru
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
  Write-Step '9) Downgrade quit — installed unchanged, loose exits'
  Uninstall-Silent
  Install-Silent $Setup018
  $v9pre = Get-InstalledVersion
  $p9 = Start-Process -FilePath $Loose017 -PassThru
  Start-Sleep -Seconds 10
  $q9 = Send-Dialog -Choice Quit -TimeoutSec 90
  if (-not $q9) { throw 'Downgrade quit dialog not found' }
  Start-Sleep -Seconds 6
  $v9post = Get-InstalledVersion
  $alive9 = Get-Process -Id $p9.Id -ErrorAction SilentlyContinue
  $n9 = Get-InstanceRootCount
  Stop-AllAutodoc
  Record '9 downgrade quit' (($v9post -eq $v9pre) -and (-not $alive9) -and ($n9 -eq 0)) "version: $v9pre -> $v9post, loose alive: $($null -ne $alive9), instances: $n9"
}
catch {
  Write-Host "FATAL: $_" -ForegroundColor Red
  throw
}
finally {
  Write-Step 'Final cleanup'
  Stop-AllAutodoc
}

Write-Host "`n=== Summary ===" -ForegroundColor Yellow
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { -not $_.Ok }).Count
Write-Host "Result: $($results.Count - $failed)/$($results.Count) passed" -ForegroundColor $(if ($failed -eq 0) {'Green'} else {'Red'})
if ($failed -gt 0) { exit 1 }
exit 0
