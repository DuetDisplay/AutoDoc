param(
  [ValidateSet('status', 'stop', 'start', 'restart')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$escapedRepoRoot = [Regex]::Escape($repoRoot)
$currentPid = $PID

function Get-ProcessSnapshot {
  Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
}

function Get-TrackedProcesses {
  param(
    [object[]]$Processes
  )

  $trackedNames = @('powershell.exe', 'pwsh.exe', 'cmd.exe', 'node.exe', 'npm.cmd', 'electron.exe')

  $Processes | Where-Object {
    $commandLine = if ($null -ne $_.CommandLine) { [string]$_.CommandLine } else { '' }

    $_.ProcessId -ne $currentPid -and
    $commandLine -and
    $commandLine -match $escapedRepoRoot -and
    $trackedNames -contains $_.Name
  }
}

function Get-RelatedProcesses {
  param(
    [object[]]$Processes,
    [int[]]$SeedIds
  )

  $byParent = @{}
  $byId = @{}
  foreach ($proc in $Processes) {
    $parentId = [int]$proc.ParentProcessId
    $byId[[int]$proc.ProcessId] = $proc
    if (-not $byParent.ContainsKey($parentId)) {
      $byParent[$parentId] = New-Object System.Collections.Generic.List[object]
    }
    $null = $byParent[$parentId].Add($proc)
  }

  $visited = New-Object System.Collections.Generic.HashSet[int]
  $stack = New-Object System.Collections.Generic.Stack[int]

  foreach ($id in $SeedIds) {
    if ($id -ne $currentPid) {
      $stack.Push($id)
    }
  }

  while ($stack.Count -gt 0) {
    $id = $stack.Pop()
    if (-not $visited.Add($id)) {
      continue
    }

    if ($byId.ContainsKey($id)) {
      $parentId = [int]$byId[$id].ParentProcessId
      if ($parentId -ne 0 -and $parentId -ne $currentPid) {
        $stack.Push($parentId)
      }
    }

    if ($byParent.ContainsKey($id)) {
      foreach ($child in $byParent[$id]) {
        if ($child.ProcessId -ne $currentPid) {
          $stack.Push([int]$child.ProcessId)
        }
      }
    }
  }

  $Processes | Where-Object { $visited.Contains([int]$_.ProcessId) }
}

function Format-ProcessLine {
  param(
    [object]$Process
  )

  $cmd = if ($null -ne $Process.CommandLine) { ([string]$Process.CommandLine).Trim() } else { '' }
  if ($cmd.Length -gt 140) {
    $cmd = $cmd.Substring(0, 137) + '...'
  }

  '{0,6}  {1,-14}  {2}' -f $Process.ProcessId, $Process.Name, $cmd
}

function Start-DevSession {
  $command = "Set-Location -LiteralPath '$repoRoot'; npm run dev"
  $proc = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) `
    -WorkingDirectory $repoRoot `
    -PassThru

  Write-Host "Started AutoDoc dev session in background (PID $($proc.Id))."
}

$processes = Get-ProcessSnapshot
$rootProcesses = @(Get-TrackedProcesses -Processes $processes)
$targetProcesses = @(
  Get-RelatedProcesses -Processes $processes -SeedIds ($rootProcesses | ForEach-Object { [int]$_.ProcessId })
) | Sort-Object ProcessId -Unique

switch ($Action) {
  'status' {
    if ($targetProcesses.Count -eq 0) {
      Write-Host "No AutoDoc dev session processes found for $repoRoot"
      exit 0
    }

    Write-Host "AutoDoc dev session processes for $repoRoot"
    foreach ($proc in $targetProcesses | Sort-Object ProcessId) {
      Write-Host (Format-ProcessLine -Process $proc)
    }
  }

  'stop' {
    if ($targetProcesses.Count -eq 0) {
      Write-Host "No AutoDoc dev session processes found for $repoRoot"
      exit 0
    }

    $stopOrder = $targetProcesses | Sort-Object `
      @{ Expression = { if ($_.Name -in @('electron.exe', 'node.exe')) { 0 } else { 1 } } }, `
      @{ Expression = { $_.ProcessId }; Descending = $true }

    foreach ($proc in $stopOrder) {
      Write-Host "Stopping $($proc.Name) ($($proc.ProcessId))"
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Milliseconds 500
    Write-Host 'AutoDoc dev session stopped.'
  }

  'start' {
    if ($targetProcesses.Count -gt 0) {
      Write-Host 'AutoDoc dev session already running:'
      foreach ($proc in $targetProcesses | Sort-Object ProcessId) {
        Write-Host (Format-ProcessLine -Process $proc)
      }
      exit 0
    }

    Start-DevSession
  }

  'restart' {
    & $PSCommandPath stop
    Start-DevSession
  }
}
