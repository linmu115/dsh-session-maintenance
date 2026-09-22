import { DatabaseSync } from "node:sqlite";
import { activeDatabasePath, loadConfig } from "./config.js";
export { recoverySystemEvidence, type RuntimeProcessIdentity, type RecoverySystemEvidence } from "@linmu/dsh-instance-integration-dsh/system-evidence";

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
    return database.prepare("SELECT id,state,started_at AS startedAt FROM projection_runs WHERE instance_id=? AND profile_id=?")
      .all(instanceId, profileId) as unknown as RecoveryRun[];
  } finally { database.close(); }
}

export function canRecoverAfterReboot(createdAt: string, runStartedAt: string, bootedAt: string, now: string): boolean {
  const times = [createdAt, runStartedAt, bootedAt, now].map(Date.parse);
  if (times.some(value => !Number.isFinite(value))) return false;
  const [created, started, boot, current] = times as [number, number, number, number];
  // A margin rejects ambiguous wall-clock boundaries, including legacy records.
  return created < boot - 60_000 && started < boot - 60_000 && boot <= current;
}
