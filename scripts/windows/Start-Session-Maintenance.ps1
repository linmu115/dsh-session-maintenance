[CmdletBinding()]
param(
    [string]$LauncherConfig = (Join-Path $env:APPDATA 'in.dsh-plug.dsh-launcher\runtime-lifecycle.json'),
    [ValidateRange(0,65535)][int]$Port = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Read the release pinned by Launcher, including after future upgrades.
$config = Get-Content -LiteralPath $LauncherConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$engineArgs = @($config.args)
$entries = @($engineArgs | Where-Object { [IO.Path]::GetFileName($_) -eq 'dsh-session-maint.mjs' })
if ($entries.Count -ne 1) { throw 'Cannot identify the Session Maintenance engine in Launcher configuration.' }
$entry = $entries[0]
$stateIndex = [Array]::IndexOf($engineArgs, '--state-root')
if ($stateIndex -lt 0 -or $stateIndex + 1 -ge $engineArgs.Count) { throw 'Launcher has no Maintenance state directory.' }
$stateRoot = $engineArgs[$stateIndex + 1]
$node = $config.program
foreach ($required in @($node, $entry, $stateRoot)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required path is missing: $required" }
}
$connectionFile = Join-Path $stateRoot 'connection.json'

function Get-ReadyEngine {
    try {
        $connection = Get-Content -LiteralPath $connectionFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $enginePort = [int]$connection.port
        if ($enginePort -lt 1 -or $enginePort -gt 65535) { return $null }
        $reply = Invoke-RestMethod -Uri "http://127.0.0.1:$enginePort/v1/integrations" `
            -Headers @{ Authorization = "Bearer $($connection.token)" } -TimeoutSec 3
        if ($null -ne $reply.directory) { return $connection }
    } catch { }
    return $null
}

# Concurrent double-clicks share one launch attempt. The engine independently
# verifies writer ownership; no lock files or run records are deleted here.
$hasher = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($stateRoot.ToLowerInvariant()))).Replace('-', '') }
finally { $hasher.Dispose() }
$mutex = [Threading.Mutex]::new($false, "Local\DSH-Session-Maintenance-$key")
$held = $false
try {
    try { $held = $mutex.WaitOne(60000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Another launch is still in progress. Please wait and retry.' }
    $ready = Get-ReadyEngine
    if ($null -ne $ready) {
        Write-Host "Session Maintenance is already ready (PID $($ready.pid), port $($ready.port))."
        exit 0
    }

    $logRoot = Join-Path $stateRoot 'logs'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdoutLog = Join-Path $logRoot "manual-start-$stamp.stdout.log"
    $stderrLog = Join-Path $logRoot "manual-start-$stamp.stderr.log"
    $arguments = @($entry, '--state-root', $stateRoot, 'serve', '--recover-dead-owner', '--port', [string]$Port)
    $dashboard = Join-Path (Split-Path (Split-Path $entry -Parent) -Parent) 'dashboard'
    if (Test-Path -LiteralPath $dashboard -PathType Container) { $arguments += @('--dashboard-root', $dashboard) }
    # Windows PowerShell joins ArgumentList; quote each argument to preserve spaces.
    $quoted = @($arguments | ForEach-Object {
        if ($_ -match '"|[\r\n]') { throw 'Unexpected quote or newline in engine configuration.' }
        '"' + $_ + '"'
    })
    $child = Start-Process -FilePath $node -ArgumentList $quoted -WorkingDirectory (Split-Path $entry -Parent) `
        -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    $deadline = (Get-Date).AddSeconds(60)
    do {
        $ready = Get-ReadyEngine
        if ($null -ne $ready) {
            Write-Host "Session Maintenance is ready (PID $($ready.pid), port $($ready.port))."
            Write-Host 'You can now start the DSH instance in Launcher.'
            Write-Host 'If Launcher still reports an unrecovered session, that run needs separate recovery.'
            exit 0
        }
        $child.Refresh()
        if ($child.HasExited) { throw "Engine exited with code $($child.ExitCode). Diagnostic log: $stderrLog" }
        Start-Sleep -Milliseconds 750
    } while ((Get-Date) -lt $deadline)
    throw "Engine is not ready yet; no process was killed. Diagnostic log: $stderrLog"
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
