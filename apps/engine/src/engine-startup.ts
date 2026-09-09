import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { MaintenanceWriteCoordinator } from "@linmu/dsh-session-store";
import { readEngineStartupFailure, recordEngineLifecycle } from "./engine-lifecycle-log.js";

/** Only the Launcher opt-in uses this; offline tools retain explicit recovery. */
export function recoverDeadEngineOwner(stateRoot: string): void {
  if (existsSync(join(stateRoot, "maintenance-writer-recovery.json"))) throw new Error("WRITER_RECOVERY_REQUIRED");
  if (!existsSync(join(stateRoot, "maintenance-writer.json"))) return;
  const owner = MaintenanceWriteCoordinator.inspect(stateRoot);
  if (owner.mode !== "engine") throw new Error("WRITER_OWNER_UNKNOWN: offline owner requires explicit inspection");
  // The store rechecks exact owner, host, PID death and connection identity
  // inside its exclusive recovery gate. Never replace this with an age check.
  MaintenanceWriteCoordinator.recoverDeadOwner(stateRoot, owner.ownerId);
  recordEngineLifecycle(stateRoot, "owner.recovered");
}

export interface EngineStartupMonitor {
  failure(): Promise<string | undefined>;
  dispose(): void;
}

function anotherEngineIsStarting(stateRoot: string, childPid: number | undefined): boolean {
  try {
    const owner = MaintenanceWriteCoordinator.inspect(stateRoot);
    if (owner.pid === childPid || owner.hostname !== hostname() || owner.mode !== "engine") return false;
    process.kill(owner.pid, 0);
    return true;
  } catch { return false; }
}

export async function startManagedEngine(stateRoot: string, entry = process.argv[1]): Promise<EngineStartupMonitor> {
  if (entry === undefined) throw new Error("ENGINE_START_UNAVAILABLE: cannot locate Maintenance entry point");
  const startedAt = Date.now();
  const child = spawn(process.execPath, [entry, "--state-root", stateRoot, "serve", "--recover-dead-owner"], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  let exitedAt: number | undefined;
  let spawnFailed = false;
  const onError = () => { spawnFailed = true; exitedAt = Date.now(); };
  const onExit = () => { exitedAt = Date.now(); };
  child.once("error", onError);
  child.once("exit", onExit);
  child.unref();
  return {
    failure: async () => {
      if (exitedAt === undefined) return undefined;
      const code = spawnFailed ? "ENGINE_SPAWN_FAILED"
        : child.pid === undefined ? "ENGINE_START_FAILED"
          : readEngineStartupFailure(stateRoot, child.pid, startedAt) ?? "ENGINE_START_FAILED";
      // Concurrent launchers can race recovery/acquisition. The losing child
      // may exit while the winner is still opening its database. Join only an
      // independently verified live Engine owner, never an offline writer.
      if (code.startsWith("WRITER_")) {
        if (anotherEngineIsStarting(stateRoot, child.pid)) return undefined;
        if (Date.now() - exitedAt < 1_000) return undefined;
      }
      return code;
    },
    dispose: () => {
      child.removeListener("exit", onExit);
      // Keep the error listener: a delayed spawn error must not be unhandled.
      child.unref();
    },
  };
}
