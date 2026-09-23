[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallationConfig)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Called by the DSH host adapter. WMI creates the helper outside the managed
# DSH process tree, so stopping that instance cannot terminate the Engine.
$installation = Get-Content -LiteralPath $InstallationConfig -Raw -Encoding UTF8 | ConvertFrom-Json
if ($installation.schemaVersion -ne 1 -or -not (Test-Path -LiteralPath $installation.entry -PathType Leaf)) {
    throw 'Maintenance installation record is invalid.'
}
$stateRoot = [IO.Path]::GetFullPath($installation.stateRoot)
$starter = Join-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) 'Start-Session-Maintenance.ps1'
if (-not (Test-Path -LiteralPath $starter -PathType Leaf)) { throw 'Maintenance starter is missing.' }

function Get-ReadyEngine {
    try {
        $connection = Get-Content -LiteralPath (Join-Path $stateRoot 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $port = [int]$connection.port
        if ($port -lt 1 -or $port -gt 65535) { return $false }
        $reply = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/integrations" `
            -Headers @{ Authorization = "Bearer $($connection.token)" } -TimeoutSec 3
        return ($null -ne $reply.directory)
    } catch { return $false }
}

if (Get-ReadyEngine) { exit 0 }
foreach ($path in @($starter, $InstallationConfig)) {
    if ($path -match '"|[\r\n]') { throw 'Invalid Maintenance installation path.' }
}
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$command = '"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    $starter + '" -InstallationConfig "' + $InstallationConfig + '"'
$startup = New-CimInstance -ClientOnly -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 }
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $command
    CurrentDirectory = (Split-Path $starter -Parent)
    ProcessStartupInformation = $startup
}
if ($created.ReturnValue -ne 0) { throw "Independent Maintenance starter failed: $($created.ReturnValue)" }
$deadline = (Get-Date).AddSeconds(180)
do {
    if (Get-ReadyEngine) { exit 0 }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
throw 'Maintenance Engine did not become ready after independent launch.'
