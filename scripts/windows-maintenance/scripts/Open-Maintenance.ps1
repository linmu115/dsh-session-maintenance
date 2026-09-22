[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$installation = Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'DSH-Session-Maintenance/engine-installation.json') -Raw | ConvertFrom-Json
if ($installation.schemaVersion -ne 1) { throw 'Unsupported Maintenance installation descriptor.' }
$entry = $installation.entry
$stateRoot = $installation.stateRoot
$releaseRoot = Split-Path (Split-Path $entry -Parent) -Parent
$dashboard = Join-Path $releaseRoot 'dashboard'
$mutex = New-Object Threading.Mutex($false, 'Local\DSHSessionMaintenanceDoubleClick')
$locked = $false
function Get-ReadyConnection {
  try {
    $c = Get-Content -LiteralPath (Join-Path $stateRoot 'connection.json') -Raw | ConvertFrom-Json
    if ($c.host -ne '127.0.0.1' -or $c.port -lt 1 -or $c.port -gt 65535 -or $c.token -notmatch '^[A-Za-z0-9_-]{32,256}$') { return $null }
    $origin = 'http://127.0.0.1:' + $c.port
    $health = Invoke-RestMethod -Uri ($origin + '/v1/health') -TimeoutSec 3
    if ($health.status.ready -ne $true) { return $null }
    return $c
  } catch { return $null }
}
try {
  try { $locked = $mutex.WaitOne(90000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another launch is still in progress. Please try again shortly.' }
  $connection = Get-ReadyConnection
  $started = $false
  if ($null -eq $connection) {
    if ($CheckOnly) { throw 'Maintenance engine is not ready.' }
    if (-not (Test-Path -LiteralPath $entry) -or -not (Test-Path -LiteralPath (Join-Path $dashboard 'index.html'))) { throw 'Installed engine or dashboard files are missing.' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    # Keep a hidden console so Node can receive a future graceful SIGINT.
    # The standalone starter reads the Maintenance installation and checks ownership.
    & (Join-Path $PSScriptRoot '../Start-Session-Maintenance.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the engine process.' }
    $started = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
      Start-Sleep -Milliseconds 500
      $connection = Get-ReadyConnection
    } while ($null -eq $connection -and [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $connection) { throw 'Engine did not become ready within 60 seconds. Check the engine lifecycle logs; no locks were removed.' }
  }
  $origin = 'http://127.0.0.1:' + $connection.port
  $launch = Invoke-RestMethod -Method Post -Uri ($origin + '/v1/ui/launch-code') -Headers @{ Authorization = ('Bearer ' + $connection.token) } -ContentType 'application/json' -Body '{}' -TimeoutSec 10
  $url = [Uri]$launch.launch.url
  if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.Port -ne $connection.port -or $url.AbsolutePath -ne '/ui/claim' -or $url.UserInfo -or $url.Fragment -or $url.Query -notmatch '^\?code=[A-Za-z0-9_-]+$') { throw 'Engine returned an invalid dashboard login entry.' }
  if (-not $CheckOnly) { Start-Process -FilePath $url.AbsoluteUri }
  Write-Output ('Maintenance ready; started=' + $started + '; browserRequested=' + (-not $CheckOnly) + '; port=' + $connection.port)
} catch {
  # Do not print HTTP exceptions: they may contain a one-time login URL.
  Write-Host 'Unable to open Maintenance. Check the installed engine and its lifecycle logs. No running process was stopped.' -ForegroundColor Red
  exit 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
