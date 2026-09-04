import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type {
  ExternalLifecycleAbortRequest,
  ExternalLifecycleAcknowledgement,
  ExternalLifecycleAfterExitRequest,
  ExternalLifecycleBeforeStopRequest,
  ExternalLifecycleBeforeStopResponse,
  ExternalLifecyclePrepareRequest,
  ExternalLifecyclePrepareResponse,
  ExternalLifecycleRequest,
  ExternalLifecycleResponse,
  RuntimeBrokerCloseRunRequest,
  RuntimeBrokerPrepareRunRequest,
  RuntimeBrokerPreparedRun,
} from "@linmu/dsh-session-contracts";
import { stringify } from "yaml";
import { z } from "zod";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9@/._:-]{0,255}$/u;
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_INPUT_BYTES = 1024 * 1024;
const BROKER_TIMEOUT_MS = 15_000;
// Canonical projection materialization is intentionally bounded by the outer
// Launcher provider timeout, but it can legitimately take longer than an
// ordinary Broker RPC for large canonical stores.
const BROKER_PREPARE_TIMEOUT_MS = 240_000;
// Final verification and crash-tail recovery may need to inspect the same
// bounded canonical projection as prepare. A 15 second RPC deadline causes the
// provider to report failure while the Engine is still safely recovering.
const BROKER_FINALIZE_TIMEOUT_MS = 240_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15_000;
// Opening an existing canonical store may apply a one-time schema migration
// before the health endpoint can listen. Large stores can legitimately take
// several minutes, so the provider must not mistake that work for a failed
// engine start.
const ENGINE_START_TIMEOUT_MS = 240_000;
const HANDLE_DIRECTORY = "external-lifecycle-handles";
const SHUTDOWN_PATH = "/dsh-session-maintenance/runtime/shutdown";
const SUPPORTED_RUNTIME_VERSION = "0.1.2-alpha.2";

const idSchema = z.string().regex(SAFE_ID);
const handleSchema = z.string().regex(SAFE_HANDLE);
const prepareRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.literal("prepare"),
  instanceId: idSchema,
  profileId: idSchema,
  runtimeVersion: z.string().min(1).max(100),
  web: z.boolean(),
});
const beforeStopRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.literal("beforeStop"),
  handle: handleSchema,
  runtimeUrl: z.string().nullable(),
});
const afterExitRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.literal("afterExit"),
  handle: handleSchema,
  exitCode: z.number().int().nullable(),
  requestedStop: z.boolean(),
  forced: z.boolean(),
});
const abortRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.literal("abort"),
  handle: handleSchema,
  reason: z.literal("spawn-failed"),
});
const requestSchema = z.discriminatedUnion("phase", [
  prepareRequestSchema,
  beforeStopRequestSchema,
  afterExitRequestSchema,
  abortRequestSchema,
]);
const connectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(32).regex(/^[A-Za-z0-9_-]+$/u),
});
const finalReceiptSchema = z.strictObject({
  disposition: z.enum(["closed", "recovered"]),
  finalizedAt: z.iso.datetime(),
});

interface EngineConnection {
  readonly origin: string;
  readonly token: string;
}

interface StoredFinalReceipt {
  readonly disposition: "closed" | "recovered";
  readonly finalizedAt: string;
}

interface StoredLifecycleHandle {
  readonly schemaVersion: 1;
  readonly handle: string;
  readonly ownerClientId: string;
  readonly runtimeClientId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly temporaryPersistenceRootId: string;
  readonly persistenceRoot: string;
  readonly patchPath: string;
  readonly dshVersion: string;
  readonly maintenanceEndpoint: string;
  readonly createdAt: string;
  readonly state: "prepared" | "shutdown-requested" | "shutdown-unavailable" | "finalized" | "recovery-required";
  readonly runtimeOrigin: string | null;
  readonly shutdownAcceptedAt: string | null;
  readonly finalReceipt: StoredFinalReceipt | null;
  readonly lastError: string | null;
}

const storedHandleSchema: z.ZodType<StoredLifecycleHandle> = z.strictObject({
  schemaVersion: z.literal(1),
  handle: handleSchema,
  ownerClientId: idSchema,
  runtimeClientId: idSchema,
  runId: idSchema,
  leaseId: idSchema,
  temporaryPersistenceRootId: idSchema,
  persistenceRoot: z.string().min(1),
  patchPath: z.string().min(1),
  dshVersion: z.string().min(1).max(100),
  maintenanceEndpoint: z.string().url(),
  createdAt: z.iso.datetime(),
  state: z.enum(["prepared", "shutdown-requested", "shutdown-unavailable", "finalized", "recovery-required"]),
  runtimeOrigin: z.string().nullable(),
  shutdownAcceptedAt: z.iso.datetime().nullable(),
  finalReceipt: finalReceiptSchema.nullable(),
  lastError: z.string().nullable(),
});

export interface ExternalLifecycleProviderDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => string;
  readonly randomId?: () => string;
  readonly connection?: () => Promise<EngineConnection>;
  readonly startEngine?: (stateRoot: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "External lifecycle provider failed").slice(0, 500);
}

function loopbackOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ProviderError("INVALID_RUNTIME_ORIGIN", "Runtime origin is invalid", false); }
  if (
    parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.username.length > 0
    || parsed.password.length > 0
  ) throw new ProviderError("INVALID_RUNTIME_ORIGIN", "Runtime origin must be loopback HTTP", false);
  return parsed.origin;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function defaultStartEngine(stateRoot: string): Promise<void> {
  const entry = process.argv[1];
  if (entry === undefined) throw new ProviderError("ENGINE_START_UNAVAILABLE", "Cannot locate the Maintenance CLI entry point", true);
  const child = spawn(process.execPath, [entry, "--state-root", stateRoot, "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export class MaintenanceExternalLifecycleProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly clock: () => string;
  private readonly randomId: () => string;
  private readonly connectionOverride: (() => Promise<EngineConnection>) | undefined;
  private readonly startEngine: (stateRoot: string) => Promise<void>;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    readonly stateRoot: string,
    dependencies: ExternalLifecycleProviderDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
    this.randomId = dependencies.randomId ?? (() => randomBytes(24).toString("base64url"));
    this.connectionOverride = dependencies.connection;
    this.startEngine = dependencies.startEngine ?? defaultStartEngine;
    this.sleep = dependencies.sleep ?? (async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async handle(value: unknown): Promise<ExternalLifecycleResponse> {
    let request: ExternalLifecycleRequest;
    try {
      request = requestSchema.parse(value) as ExternalLifecycleRequest;
    } catch (error) {
      throw new ProviderError(
        error instanceof z.ZodError ? "INVALID_REQUEST" : "PROVIDER_FAILURE",
        errorMessage(error),
        !(error instanceof z.ZodError),
      );
    }
    switch (request.phase) {
      case "prepare": return this.prepare(request);
      case "beforeStop": return this.beforeStop(request);
      case "afterExit": return this.afterExit(request);
      case "abort": return this.abort(request);
    }
  }

  private async prepare(request: ExternalLifecyclePrepareRequest): Promise<ExternalLifecyclePrepareResponse> {
    if (!request.web || request.runtimeVersion !== SUPPORTED_RUNTIME_VERSION) {
      return { schemaVersion: 1, enabled: false, handle: null, launch: null };
    }
    const configuration = {
      branchId: "main",
      pinnedAdapterId: null,
      projectSelection: { kind: "all" } as const,
    };
    const connection = await this.ensureConnection();
    const nonce = this.randomId();
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) throw new ProviderError("RANDOM_ID_INVALID", "Provider random ID is invalid", false);
    const handle = `maintenance-${nonce}`;
    const ownerClientId = `launcher-${nonce}`;
    const runtimeClientId = `plugin-${nonce}`;
    const body: RuntimeBrokerPrepareRunRequest = {
      schemaVersion: 1,
      client: { kind: "launcher", id: ownerClientId },
      runtimeClientId,
      instanceId: request.instanceId,
      profileId: request.profileId,
      dshVersion: request.runtimeVersion,
      maintenanceEndpoint: connection.origin,
      branchId: configuration.branchId as RuntimeBrokerPrepareRunRequest["branchId"],
      environment: {
        packageVersions: {
          "@deepseek-ai/dsh-session": request.runtimeVersion,
          "@deepseek-ai/dsh-session-persistence": request.runtimeVersion,
        },
        runtimeCapabilities: ["sessionPersistence", "session/event", "session/flush"],
      },
      pinnedAdapterId: configuration.pinnedAdapterId as RuntimeBrokerPrepareRunRequest["pinnedAdapterId"],
      projectSelection: configuration.projectSelection as RuntimeBrokerPrepareRunRequest["projectSelection"],
    };
    const preparedEnvelope = await this.brokerRequest<{ readonly run: RuntimeBrokerPreparedRun }>(
      connection,
      "/v1/runtime-broker/runs/prepare",
      body,
      BROKER_PREPARE_TIMEOUT_MS,
    );
    const run = preparedEnvelope.run;
    if (
      run.schemaVersion !== 1
      || run.state !== "preparing"
      || run.runtimeClientId !== runtimeClientId
      || !SAFE_ID.test(run.runId)
      || !SAFE_ID.test(run.leaseId)
      || !SAFE_ID.test(run.temporaryPersistenceRootId)
      || !isAbsolute(run.persistenceRoot)
    ) throw new ProviderError("BROKER_PREPARE_INVALID", "Runtime Broker prepare acknowledgement is invalid", true);
    try {
    const projectionRoot = dirname(run.persistenceRoot);
    const patchPath = join(projectionRoot, "external-lifecycle.patch.yml");
    await mkdir(projectionRoot, { recursive: true });
    const patch = stringify([{
      id: "session-persistence-jsonl",
      config: { root: run.persistenceRoot },
    }]);
    const patchHandle = await open(patchPath, "w", 0o600);
    try {
      await patchHandle.writeFile(patch, "utf8");
      await patchHandle.sync();
    } finally {
      await patchHandle.close();
    }
    const metadata = {
      schemaVersion: 1,
      sessionSource: "maintenance",
      maintenanceEndpoint: connection.origin,
      adapterSelection: configuration.pinnedAdapterId === null ? "auto" : "pinned",
      pinnedAdapterId: configuration.pinnedAdapterId,
      branchId: configuration.branchId,
      ownerClientId,
      runtimeClientId,
      runId: run.runId,
      temporaryPersistenceRootId: run.temporaryPersistenceRootId,
      dshVersion: request.runtimeVersion,
    };
    const stored: StoredLifecycleHandle = {
      schemaVersion: 1,
      handle,
      ownerClientId,
      runtimeClientId,
      runId: run.runId,
      leaseId: run.leaseId,
      temporaryPersistenceRootId: run.temporaryPersistenceRootId,
      persistenceRoot: run.persistenceRoot,
      patchPath,
      dshVersion: request.runtimeVersion,
      maintenanceEndpoint: connection.origin,
      createdAt: this.clock(),
      state: "prepared",
      runtimeOrigin: null,
      shutdownAcceptedAt: null,
      finalReceipt: null,
      lastError: null,
    };
    await this.writeHandle(stored);
    return {
      schemaVersion: 1,
      enabled: true,
      handle,
      launch: {
        launcherArgs: ["--patch", patchPath],
        args: [],
        env: {
          DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE: JSON.stringify(metadata),
          DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY: join(this.stateRoot, "connection.json"),
        },
      },
    };
    } catch (error) {
      try {
        await this.brokerRequest(connection, `/v1/runtime-broker/runs/${encodeURIComponent(run.runId)}/close`, {
          schemaVersion: 1,
          clientId: ownerClientId,
          runId: run.runId,
          reason: "recovery",
        } satisfies RuntimeBrokerCloseRunRequest);
      } catch (cleanupError) {
        throw new ProviderError(
          "PREPARE_CLEANUP_FAILED",
          `Provider setup failed and the prepared run requires recovery: ${errorMessage(cleanupError)}`,
          true,
        );
      }
      throw error;
    }
  }

  private async beforeStop(request: ExternalLifecycleBeforeStopRequest): Promise<ExternalLifecycleBeforeStopResponse> {
    const stored = await this.readHandle(request.handle);
    if (stored.finalReceipt !== null) {
      return { schemaVersion: 1, action: "force" };
    }
    if (stored.shutdownAcceptedAt !== null) {
      return {
        schemaVersion: 1,
        action: "wait",
        timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      };
    }
    if (request.runtimeUrl === null) {
      await this.writeHandle({ ...stored, state: "shutdown-unavailable", lastError: "DSH runtime origin is unavailable" });
      return { schemaVersion: 1, action: "force" };
    }
    const runtimeOrigin = loopbackOrigin(request.runtimeUrl);
    try {
      const connection = await this.ensureConnection();
      const response = await this.fetchImpl(`${runtimeOrigin}${SHUTDOWN_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ schemaVersion: 1, runId: stored.runId, clientId: stored.ownerClientId }),
        signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
      });
      if (response.status !== 202) throw new Error(`DSH graceful shutdown returned HTTP ${response.status}`);
      const acceptedAt = this.clock();
      await this.writeHandle({
        ...stored,
        state: "shutdown-requested",
        runtimeOrigin,
        shutdownAcceptedAt: acceptedAt,
        lastError: null,
      });
      return {
        schemaVersion: 1,
        action: "wait",
        timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      };
    } catch (error) {
      await this.writeHandle({
        ...stored,
        state: "shutdown-unavailable",
        runtimeOrigin,
        lastError: errorMessage(error),
      });
      return { schemaVersion: 1, action: "force" };
    }
  }

  private async afterExit(request: ExternalLifecycleAfterExitRequest): Promise<ExternalLifecycleAcknowledgement> {
    const stored = await this.readHandle(request.handle);
    if (stored.finalReceipt !== null) return { schemaVersion: 1, ok: true };
    const normalCloseWasAuthorized = request.requestedStop
      && !request.forced
      && stored.shutdownAcceptedAt !== null;
    return this.finalize(stored, normalCloseWasAuthorized ? "normal" : "recovery");
  }

  private async abort(request: ExternalLifecycleAbortRequest): Promise<ExternalLifecycleAcknowledgement> {
    const stored = await this.readHandle(request.handle);
    if (stored.finalReceipt !== null) return { schemaVersion: 1, ok: true };
    return this.finalize(stored, "recovery");
  }

  private async finalize(
    stored: StoredLifecycleHandle,
    initialReason: RuntimeBrokerCloseRunRequest["reason"],
  ): Promise<ExternalLifecycleAcknowledgement> {
    const connection = await this.ensureConnection();
    let reason = initialReason;
    let closed: { readonly run: { readonly state?: unknown; readonly removedProjection?: unknown } };
    try {
      closed = await this.closeRun(connection, stored, reason);
    } catch (error) {
      if (reason === "recovery") {
        await this.writeHandle({ ...stored, state: "recovery-required", lastError: errorMessage(error) });
        throw new ProviderError("RECOVERY_REQUIRED", errorMessage(error), true);
      }
      reason = "recovery";
      try {
        closed = await this.closeRun(connection, stored, reason);
      } catch (recoveryError) {
        await this.writeHandle({ ...stored, state: "recovery-required", lastError: errorMessage(recoveryError) });
        throw new ProviderError("RECOVERY_REQUIRED", errorMessage(recoveryError), true);
      }
    }
    const disposition = closed.run.state === "closed" && reason === "normal" ? "closed" : "recovered";
    if (closed.run.removedProjection !== true) {
      await this.writeHandle({ ...stored, state: "recovery-required", lastError: "Broker did not confirm projection cleanup" });
      throw new ProviderError("BROKER_CLOSE_INVALID", "Runtime Broker did not confirm projection cleanup", true);
    }
    const receipt: StoredFinalReceipt = {
      disposition,
      finalizedAt: this.clock(),
    };
    await this.writeHandle({ ...stored, state: "finalized", finalReceipt: receipt, lastError: null });
    return { schemaVersion: 1, ok: true };
  }

  private closeRun(
    connection: EngineConnection,
    stored: StoredLifecycleHandle,
    reason: RuntimeBrokerCloseRunRequest["reason"],
  ): Promise<{ readonly run: { readonly state?: unknown; readonly removedProjection?: unknown } }> {
    return this.brokerRequest(connection, `/v1/runtime-broker/runs/${encodeURIComponent(stored.runId)}/close`, {
      schemaVersion: 1,
      clientId: stored.ownerClientId,
      runId: stored.runId as RuntimeBrokerCloseRunRequest["runId"],
      reason,
    } satisfies RuntimeBrokerCloseRunRequest, BROKER_FINALIZE_TIMEOUT_MS);
  }

  private async brokerRequest<T>(
    connection: EngineConnection,
    path: string,
    body: unknown,
    timeoutMs = BROKER_TIMEOUT_MS,
  ): Promise<T> {
    const response = await this.fetchImpl(`${connection.origin}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        origin: connection.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `Runtime Broker returned HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { readonly error?: { readonly message?: unknown } };
        if (typeof parsed.error?.message === "string") message = parsed.error.message;
      } catch {}
      throw new ProviderError("BROKER_REQUEST_FAILED", message.slice(0, 500), true);
    }
    try { return JSON.parse(text) as T; } catch { throw new ProviderError("BROKER_RESPONSE_INVALID", "Runtime Broker response is invalid", true); }
  }

  private async ensureConnection(): Promise<EngineConnection> {
    if (this.connectionOverride !== undefined) return this.connectionOverride();
    const existing = await this.tryConnection();
    if (existing !== null) return existing;
    await this.startEngine(this.stateRoot);
    const deadline = Date.now() + ENGINE_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.sleep(100);
      const connection = await this.tryConnection();
      if (connection !== null) return connection;
    }
    throw new ProviderError("ENGINE_START_TIMEOUT", "Session Maintenance Engine did not become ready", true);
  }

  private async tryConnection(): Promise<EngineConnection | null> {
    try {
      const descriptor = connectionSchema.parse(JSON.parse(await readFile(join(this.stateRoot, "connection.json"), "utf8")));
      const connection = { origin: `http://127.0.0.1:${descriptor.port}`, token: descriptor.token };
      const health = await this.fetchImpl(`${connection.origin}/v1/health`, { signal: AbortSignal.timeout(2_000) });
      return health.ok ? connection : null;
    } catch {
      return null;
    }
  }

  private handlePath(handle: string): string {
    if (!SAFE_HANDLE.test(handle)) throw new ProviderError("INVALID_HANDLE", "External lifecycle handle is invalid", false);
    return join(this.stateRoot, HANDLE_DIRECTORY, `${handle}.json`);
  }

  private async readHandle(handle: string): Promise<StoredLifecycleHandle> {
    try {
      return storedHandleSchema.parse(JSON.parse(await readFile(this.handlePath(handle), "utf8")));
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code === "ENOENT") throw new ProviderError("HANDLE_NOT_FOUND", "External lifecycle handle does not exist", false);
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("HANDLE_INVALID", "External lifecycle handle context is invalid", false);
    }
  }

  private writeHandle(value: StoredLifecycleHandle): Promise<void> {
    return atomicWrite(this.handlePath(value.handle), value);
  }
}

export async function runExternalLifecycleStdio(
  input: string,
  provider: MaintenanceExternalLifecycleProvider,
): Promise<ExternalLifecycleResponse> {
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new ProviderError("INPUT_TOO_LARGE", "External lifecycle request exceeds 1 MiB", false);
  }
  let value: unknown;
  try { value = JSON.parse(input); } catch {
    throw new ProviderError("INVALID_JSON", "External lifecycle request is not valid JSON", false);
  }
  return provider.handle(value);
}
