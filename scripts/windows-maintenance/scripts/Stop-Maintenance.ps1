[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$stopRequestedAt=[DateTime]::UtcNow
$guardText = & node (Join-Path $PSScriptRoot 'maintenance-stop-preflight.mjs')
if($LASTEXITCODE -ne 0){throw 'Engine stop preflight failed; no signal sent'}
$guard=$guardText | ConvertFrom-Json
$enginePid=[uint32]$guard.pid
$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$enginePid"
$lifecycle=Get-Content (Join-Path $env:LOCALAPPDATA 'DSH-Session-Maintenance/engine-installation.json') -Raw | ConvertFrom-Json
$entries=@($lifecycle.entry)
if ($lifecycle.schemaVersion -ne 1) { throw 'Unsupported Maintenance installation descriptor' }
# Windows accepts both separators. Match a complete argument after normalizing
# separators, rather than rejecting the same executable under its alternate spelling.
function Test-CommandArgument([string]$command,[string]$argument) {
 $normalized=$command.Replace('\','/')
 $expected=$argument.Replace('\','/')
 return [regex]::IsMatch($normalized,'(?:^|\s)"?'+[regex]::Escape($expected)+'"?(?=\s|$)',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
if($entries.Count -ne 1 -or $proc.Name -ne 'node.exe' -or -not (Test-CommandArgument $proc.CommandLine $entries[0]) -or -not (Test-CommandArgument $proc.CommandLine 'serve') -or [IO.Path]::GetFullPath($proc.ExecutablePath) -ine [IO.Path]::GetFullPath($lifecycle.program)){throw 'Engine process identity mismatch; no signal sent'}
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class MaintenanceGracefulConsole {
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll",SetLastError=true)] public static extern uint GetConsoleProcessList(uint[] ids,uint count);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint kind,uint group);
}
"@
[MaintenanceGracefulConsole]::FreeConsole() | Out-Null
if(-not [MaintenanceGracefulConsole]::AttachConsole($enginePid)){throw 'Engine has no accessible console; no signal sent and no force fallback'}
try {
 $ids=New-Object uint32[] 64
 $count=[MaintenanceGracefulConsole]::GetConsoleProcessList($ids,64)
 $others=@($ids | Where-Object {$_ -ne 0 -and $_ -ne $PID -and $_ -ne $enginePid})
 if($count -ne 2 -or $others.Count -ne 0){throw 'Console is shared; no signal sent'}
 [MaintenanceGracefulConsole]::SetConsoleCtrlHandler([IntPtr]::Zero,$true) | Out-Null
 if(-not [MaintenanceGracefulConsole]::GenerateConsoleCtrlEvent(0,0)){throw 'Could not send graceful SIGINT'}
 Start-Sleep -Milliseconds 300
}finally{[MaintenanceGracefulConsole]::FreeConsole() | Out-Null}
$deadline=(Get-Date).AddSeconds(30)
while((Get-Process -Id $enginePid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 300}
if(Get-Process -Id $enginePid -ErrorAction SilentlyContinue){throw 'Graceful exit timed out; process left running'}
$log=Join-Path $env:LOCALAPPDATA "DSH-Session-Maintenance/logs/engine-lifecycle/$enginePid.jsonl"
$events=@(Get-Content $log | ForEach-Object {$_ | ConvertFrom-Json} | Where-Object { [DateTime]$_.at -ge $stopRequestedAt })
foreach($stage in @('shutdown.requested','shutdown.drained','owner.released','shutdown.completed')){if($stage -notin $events.stage){throw "Exit receipt missing: $stage"}}
$receiptPath=Join-Path $env:LOCALAPPDATA "DSH-Session-Maintenance/logs/engine-lifecycle/$enginePid.stop-verified.json"
[ordered]@{at=[DateTime]::UtcNow.ToString('o');pid=$enginePid;graceful=$true;signal='SIGINT';drainVerified=$true;ownerReleased=$true;forced=$false} | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding utf8
Write-Output "Engine $enginePid exited with verified drain and owner-release receipts."
