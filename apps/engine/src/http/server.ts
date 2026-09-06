import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

import { engineConnectionDescriptorSchema, SessionMaintenanceError } from "@linmu/dsh-session-contracts";

import type { SessionMaintenanceEngine } from "../engine.js";
import type { JobRunner } from "../jobs/job-runner.js";
import type { JobStore } from "../jobs/job-store.js";
import { routeRequest } from "./routes.js";
import { serveDashboardAsset } from "./dashboard.js";
import { UiSessionManager } from "./ui-session.js";

const execFileAsync = promisify(execFile);

export function windowsIdentitySid(output: string): string {
  const sid = /\bS-\d-\d+(?:-\d+)+\b/u.exec(output)?.[0];
  if (sid === undefined) throw new Error("Unable to resolve the current Windows SID");
  return sid;
}

export function windowsAclArgv(path: string, sid: string): readonly string[] {
  if (!/^S-\d-\d+(?:-\d+)+$/u.test(sid)) throw new TypeError("Invalid Windows SID");
  return [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`];
}

async function secureConnectionFile(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const identity = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { shell: false, windowsHide: true });
  const sid = windowsIdentitySid(identity.stdout);
  await execFileAsync("icacls.exe", [...windowsAclArgv(path, sid)], { shell: false, windowsHide: true });
}

export interface MaintenanceServer {
  readonly origin: string;
  readonly token: string;
  readonly jobStore: JobStore;
  readonly jobs: JobRunner;
  readonly uiSessions: UiSessionManager;
  readonly close: () => Promise<void>;
}

export async function startMaintenanceServer(input: {
  readonly engine: SessionMaintenanceEngine;
  readonly stateRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly skipAcl?: boolean;
  readonly dashboardRoot?: string;
}): Promise<MaintenanceServer> {
  const host = input.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new SessionMaintenanceError("LOOPBACK_ONLY", `Refusing non-loopback host: ${host}`);
  const token = randomBytes(32).toString("base64url");
  const jobStore = input.engine.jobStore;
  const jobs = input.engine.jobs;
  const uiSessions = new UiSessionManager();
  let origin = "";
  const responses = new Set<import("node:http").ServerResponse>();
  const server: Server = createServer((request, response) => {
    responses.add(response);
    response.once("close", () => responses.delete(response));
    void (async () => {
      if (input.dashboardRoot !== undefined && await serveDashboardAsset(request, response, input.dashboardRoot)) return;
      await routeRequest(request, response, { engine: input.engine, jobs, jobStore, token, origin, uiSessions });
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      if (!response.writableEnded) response.end(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Loopback server did not expose a TCP address");
  origin = `http://${host}:${address.port}`;
  const connectionPath = join(input.stateRoot, "connection.json");
  try {
    const descriptor = engineConnectionDescriptorSchema.parse({
      schemaVersion: 1, host, port: address.port, token,
      pid: process.pid, ownerId: input.engine.writes?.captureEvidence().ownerId,
    });
    await writeFile(connectionPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    if (input.skipAcl !== true) await secureConnectionFile(connectionPath);
  } catch (error) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(connectionPath, { force: true });
    throw error;
  }
  await input.engine.runWrite("job-recovery", () => jobs.start());
  return {
    origin,
    token,
    jobStore,
    jobs,
    uiSessions,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      // SSE subscriptions otherwise keep close() waiting indefinitely. Closing
      // only event streams aborts their read loops while active requests drain.
      for (const response of responses) if (String(response.getHeader("content-type")).startsWith("text/event-stream")) response.end();
      await jobs.stopImports();
      await closed;
      await input.engine.writes?.drain();
      await rm(connectionPath, { force: true });
    },
  };
}
