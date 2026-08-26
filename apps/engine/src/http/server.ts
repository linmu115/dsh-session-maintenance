import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

import { SessionMaintenanceError } from "@linmu/dsh-session-contracts";

import type { SessionMaintenanceEngine } from "../engine.js";
import { JobRunner } from "../jobs/job-runner.js";
import { JobStore } from "../jobs/job-store.js";
import { routeRequest } from "./routes.js";

const execFileAsync = promisify(execFile);

export function windowsAclArgv(path: string, account: string): readonly string[] {
  return [path, "/inheritance:r", "/grant:r", `${account}:(F)`];
}

async function secureConnectionFile(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const identity = await execFileAsync("whoami.exe", [], { shell: false, windowsHide: true });
  const account = identity.stdout.trim();
  await execFileAsync("icacls.exe", [...windowsAclArgv(path, account)], { shell: false, windowsHide: true });
}

export interface MaintenanceServer {
  readonly origin: string;
  readonly token: string;
  readonly jobStore: JobStore;
  readonly jobs: JobRunner;
  readonly close: () => Promise<void>;
}

export async function startMaintenanceServer(input: {
  readonly engine: SessionMaintenanceEngine;
  readonly stateRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly skipAcl?: boolean;
}): Promise<MaintenanceServer> {
  const host = input.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new SessionMaintenanceError("LOOPBACK_ONLY", `Refusing non-loopback host: ${host}`);
  const token = randomBytes(32).toString("base64url");
  const jobStore = new JobStore(input.engine.repository.database);
  const jobs = new JobRunner(input.engine, jobStore);
  let origin = "";
  const server: Server = createServer((request, response) => {
    void routeRequest(request, response, { engine: input.engine, jobs, jobStore, token, origin });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Loopback server did not expose a TCP address");
  origin = `http://${host}:${address.port}`;
  const connectionPath = join(input.stateRoot, "connection.json");
  await writeFile(connectionPath, `${JSON.stringify({ schemaVersion: 1, host, port: address.port, token })}\n`, { mode: 0o600 });
  if (input.skipAcl !== true) await secureConnectionFile(connectionPath);
  jobs.start();
  return {
    origin,
    token,
    jobStore,
    jobs,
    close: async () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}
