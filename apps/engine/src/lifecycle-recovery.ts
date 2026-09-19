import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { activeDatabasePath, loadConfig } from "./config.js";
import { windowsSystemTool } from "./integrations/windows-tools.js";

export interface RuntimeProcessIdentity {
  readonly pid: number;
  readonly startedAt: string;
  readonly bootedAt: string;
}
export interface RecoverySystemEvidence {
  readonly bootedAt: string;
  readonly process: RuntimeProcessIdentity | null;
}
export interface RecoveryRun {
  readonly id: string;
  readonly state: string;
  readonly startedAt: string;
}

/** Read only. The Broker remains the only writer and recovery authority. */
export async function scopedRecoveryRuns(stateRoot: string, instanceId: string, profileId: string): Promise<RecoveryRun[]> {
  let config;
  try { config = await loadConfig(stateRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const database = new DatabaseSync(activeDatabasePath(stateRoot, config), { readOnly: true });
  try {
    return database.prepare("SELECT id,state,started_at AS startedAt FROM projection_runs WHERE instance_id=? AND profile_id=? AND state!='quarantined'")
      .all(instanceId, profileId) as unknown as RecoveryRun[];
  } finally { database.close(); }
}

/** Use the OS boot time, not process uptime or an unreachable network port. */
export async function recoverySystemEvidence(pid?: number): Promise<RecoverySystemEvidence> {
  if (process.platform !== "win32") throw new Error("此平台尚不能核实旧运行的退出身份，已保留旧运行。");
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) throw new Error("Invalid process ID");
  const script = `$ErrorActionPreference='Stop'; $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); `
    + (pid === undefined ? "$item=$null; " : `$item=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; `)
    + "@{bootedAt=$boot;process=$(if($null -eq $item){$null}else{@{pid=[int]$item.ProcessId;startedAt=$item.CreationDate.ToUniversalTime().ToString('o');bootedAt=$boot}})} | ConvertTo-Json -Compress";
  const { stdout } = await promisify(execFile)(windowsSystemTool("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 });
  const value = JSON.parse(stdout) as RecoverySystemEvidence;
  if (!Number.isFinite(Date.parse(value.bootedAt)) || (value.process !== null && (
    value.process.pid !== pid || !Number.isFinite(Date.parse(value.process.startedAt))
  ))) throw new Error("无法核实操作系统进程身份，已保留旧运行。");
  return value;
}

export function canRecoverAfterReboot(createdAt: string, runStartedAt: string, bootedAt: string, now: string): boolean {
  const times = [createdAt, runStartedAt, bootedAt, now].map(Date.parse);
  if (times.some(value => !Number.isFinite(value))) return false;
  const [created, started, boot, current] = times as [number, number, number, number];
  // A margin rejects ambiguous wall-clock boundaries, including legacy records.
  return created < boot - 60_000 && started < boot - 60_000 && boot <= current;
}
