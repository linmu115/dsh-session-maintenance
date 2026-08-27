import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import {
  CODEX_SCHEMA_FINGERPRINT,
  CODEX_SUPPORTED_VERSION,
  parseCodexJsonl,
  probeCodexInstance,
  resolveContainedRollout,
} from "@linmu/dsh-adapter-codex-read";
import {
  SessionMaintenanceError,
  type BackupManifest,
  type JsonValue,
  type NormalizedSession,
  type PlatformWriteAdapter,
  type PreparedWrite,
  type PrepareWriteRequest,
  type RegisteredInstance,
  type RestoreReceipt,
  type StateFingerprint,
  type SyncPlan,
  type TransactionContext,
  type VerificationResult,
  type WriteProbe,
  type WriteReceipt,
} from "@linmu/dsh-session-contracts";
import { canonicalJson, validateExecutableCodexPlan } from "@linmu/dsh-session-domain";
import { TransactionBackupStore } from "@linmu/dsh-session-transaction-engine";

import { mapDshEventsToCodex } from "./mapping.js";

const EXTRA_SPACE_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

interface NativeDescriptor {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly sourceRollout: string;
  readonly destinationRollout: string;
  readonly destinationExisted: boolean;
  readonly title: string;
  readonly archived: boolean;
  readonly updatedAtMs: number;
  readonly candidateDatabase: string;
  readonly candidateIndex: string;
  readonly candidateRollout: string;
  readonly rolloutSha256: string;
}

export interface CodexNativeAdapterOptions {
  readonly stateRoot: string;
  readonly loadSource: (plan: SyncPlan) => Promise<NormalizedSession>;
  readonly fixtureGuard?: (root: string) => void;
  readonly quietDelayMs?: number;
  readonly faultAt?: "after-rollout" | "after-index" | "after-database";
  readonly now?: () => Date;
  readonly registeredRoots?: ReadonlyMap<string, string>;
  readonly codexProcessRunning?: () => Promise<boolean>;
}

async function defaultCodexProcessRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist.exe",
        ["/FI", "IMAGENAME eq codex.exe", "/FO", "CSV", "/NH"],
        { windowsHide: true },
      );
      return /"codex\.exe"/iu.test(stdout);
    }
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "comm="]);
    return stdout.split(/\r?\n/u).some((name) => /(^|\/)codex$/iu.test(name.trim()));
  } catch {
    // Native storage maintenance must not guess that an unknown process state
    // is safe. A failed process probe is therefore treated as busy.
    return true;
  }
}

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}

async function optionalBytes(path: string): Promise<Uint8Array | undefined> {
  try { return await readFile(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.dsm-tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await unlink(temporary).catch((error) => { if (!isMissing(error)) throw error; }); }
}

function archiveRelative(path: string, archived: boolean): string {
  const file = basename(path);
  if (archived) return join("archived_sessions", file);
  const date = /^rollout-(\d{4})-(\d{2})-(\d{2})T/u.exec(file);
  if (date === null) {
    throw new SessionMaintenanceError("CODEX_SCHEMA_DRIFT", `Cannot reconstruct Codex rollout date: ${file}`);
  }
  return join("sessions", date[1]!, date[2]!, date[3]!, file);
}

function targetFingerprint(instanceId: string, sessionId: string, value: string): StateFingerprint {
  return { platform: "codex", instanceId, sessionId, kind: "content", value };
}

function operation<T extends SyncPlan["operations"][number]["type"]>(plan: SyncPlan, type: T) {
  return plan.operations.find((item) => item.type === type) as
    Extract<SyncPlan["operations"][number], { readonly type: T }> | undefined;
}

export class CodexNativeWriteAdapter implements PlatformWriteAdapter {
  readonly platform = "codex" as const;
  readonly options: CodexNativeAdapterOptions;
  private readonly activeRoots = new Map<string, string>();

  constructor(options: CodexNativeAdapterOptions) {
    if (process.env.VITEST !== undefined && options.fixtureGuard === undefined) {
      throw new Error("CodexNativeWriteAdapter requires a fixture guard under Vitest");
    }
    this.options = options;
  }

  async probeWrite(instance: RegisteredInstance): Promise<WriteProbe> {
    this.remember(instance);
    const readProbe = await probeCodexInstance(instance, this.options.fixtureGuard, () => undefined);
    if (readProbe.status !== "compatible") {
      return { status: "unsupported", contract: this.contract(instance.platformVersion, "unsupported"), capabilities: [], issues: readProbe.issues };
    }
    try {
      await this.assertQuiescent(instance.root);
      return {
        status: "compatible",
        contract: this.contract(instance.platformVersion),
        capabilities: ["append-events", "update-title", "update-archive", "verify", "restore"],
        issues: [],
      };
    } catch (error) {
      const code = error instanceof SessionMaintenanceError ? error.code : "CODEX_BUSY";
      return { status: "degraded", contract: this.contract(instance.platformVersion), capabilities: [], issues: [{ code, message: "Codex is not quiescent for native storage maintenance" }] };
    }
  }

  async prepare(request: PrepareWriteRequest): Promise<PreparedWrite> {
    this.remember(request.instance);
    validateExecutableCodexPlan(request.plan);
    this.options.fixtureGuard?.(request.instance.root);
    const probe = await probeCodexInstance(request.instance, this.options.fixtureGuard, () => undefined);
    if (probe.status !== "compatible") {
      throw new SessionMaintenanceError("CODEX_VERSION_UNSUPPORTED", "Codex version or storage schema is not allowlisted");
    }
    await this.assertQuiescent(request.instance.root);
    const source = await this.options.loadSource(request.plan);
    const append = operation(request.plan, "append-events");
    const events = append === undefined ? [] : source.events.slice(append.fromIndex);
    if (append !== undefined && canonicalJson(append.eventIds as unknown as JsonValue) !== canonicalJson(events.map((item) => item.id) as unknown as JsonValue)) {
      throw new SessionMaintenanceError("PLAN_STALE", "Codex append event identities drifted");
    }
    const target = request.plan.target!;
    const database = new DatabaseSync(join(request.instance.root, "state_5.sqlite"), { readOnly: true });
    let row: { readonly rollout_path: string; readonly title: string; readonly archived: number; readonly updated_at_ms: number | null } | undefined;
    try {
      row = database.prepare("SELECT rollout_path, title, archived, updated_at_ms FROM threads WHERE id = ?").get(target.key.sessionId) as typeof row;
    } finally { database.close(); }
    if (row === undefined) throw new SessionMaintenanceError("PLAN_STALE", "Codex target thread disappeared");
    const sourcePath = await resolveContainedRollout(request.instance.root, row.rollout_path);
    const title = operation(request.plan, "update-title")?.title ?? row.title;
    const archived = operation(request.plan, "update-archive")?.archived ?? Boolean(row.archived);
    const destinationRelative = archived === Boolean(row.archived) ? row.rollout_path : archiveRelative(row.rollout_path, archived);
    const destinationPath = resolve(request.instance.root, destinationRelative);
    const destinationExisted = (await optionalBytes(destinationPath)) !== undefined;
    const candidateRoot = join(this.options.stateRoot, "transactions", request.transaction.id, "codex-candidate");
    await mkdir(candidateRoot, { recursive: true });
    const originalRollout = await readFile(sourcePath);
    const lines = mapDshEventsToCodex(events, request.transaction.startedAt).map((item) => JSON.stringify(item));
    const rollout = Buffer.concat([originalRollout, Buffer.from(lines.length === 0 ? "" : `${originalRollout.at(-1) === 10 ? "" : "\n"}${lines.join("\n")}\n`)]);
    const updatedAtMs = Math.max(Date.parse(request.transaction.startedAt), (row.updated_at_ms ?? 0) + 1);
    const candidateRollout = join(candidateRoot, "rollout.jsonl");
    const candidateIndex = join(candidateRoot, "session_index.jsonl");
    const candidateDatabase = join(candidateRoot, "state_5.sqlite");
    await writeFile(candidateRollout, rollout);
    const index = await readFile(join(request.instance.root, "session_index.jsonl"));
    await writeFile(candidateIndex, Buffer.concat([index, Buffer.from(`${index.at(-1) === 10 ? "" : "\n"}${JSON.stringify({ id: target.key.sessionId, thread_name: title, updated_at: new Date(updatedAtMs).toISOString() })}\n`)]));
    await this.assertDiskSpace(request.instance.root, rollout.byteLength + index.byteLength);
    await this.withExclusive(request.instance.root, async (databasePath) => {
      await copyFile(databasePath, candidateDatabase);
    }, true);
    const candidateDb = new DatabaseSync(candidateDatabase);
    try {
      candidateDb.exec("PRAGMA journal_mode = DELETE");
      candidateDb.prepare(`UPDATE threads SET title = ?, archived = ?, archived_at = ?, rollout_path = ?,
        updated_at = ?, updated_at_ms = ?, recency_at = ?, recency_at_ms = ?, preview = ? WHERE id = ?`).run(
        title, archived ? 1 : 0, archived ? Math.floor(updatedAtMs / 1000) : null,
        destinationRelative, Math.floor(updatedAtMs / 1000), updatedAtMs,
        Math.floor(updatedAtMs / 1000), updatedAtMs, events.at(-1)?.content ?? title, target.key.sessionId,
      );
    } finally { candidateDb.close(); }
    const descriptor: NativeDescriptor = {
      schemaVersion: 1,
      transactionId: request.transaction.id,
      planId: request.plan.id,
      planHash: request.plan.hash,
      instanceId: request.instance.id,
      sessionId: target.key.sessionId,
      sourceRollout: row.rollout_path,
      destinationRollout: destinationRelative,
      destinationExisted,
      title,
      archived,
      updatedAtMs,
      candidateDatabase,
      candidateIndex,
      candidateRollout,
      rolloutSha256: hash(rollout),
    };
    await this.validateCandidate(descriptor);
    await atomicWrite(this.descriptorPath(request.transaction.id), `${canonicalJson(descriptor as unknown as JsonValue)}\n`);
    return {
      id: `prepared-${request.transaction.id}`,
      planId: request.plan.id,
      planHash: request.plan.hash,
      platform: "codex",
      instanceId: request.instance.id,
      rootIdentity: resolve(request.instance.root).toLocaleLowerCase("en-US"),
      targetKey: target.key,
      expected: { fingerprints: [] },
      payload: { rolloutSha256: descriptor.rolloutSha256 },
    };
  }

  async backup(prepared: PreparedWrite, transaction: TransactionContext): Promise<BackupManifest> {
    const descriptor = await this.readDescriptor(transaction.id);
    this.assertScope(prepared, transaction, descriptor);
    const root = this.instanceRoot(prepared);
    await this.assertQuiescent(root);
    const store = this.store(transaction.id);
    const entries = [];
    for (const [logicalName, path, required] of [
      ["state_5.sqlite", join(root, "state_5.sqlite"), true],
      ["session_index.jsonl", join(root, "session_index.jsonl"), true],
      ["rollout-source", resolve(root, descriptor.sourceRollout), true],
      ["state_5.sqlite-wal", join(root, "state_5.sqlite-wal"), false],
      ["state_5.sqlite-shm", join(root, "state_5.sqlite-shm"), false],
      ...(descriptor.destinationRollout !== descriptor.sourceRollout && descriptor.destinationExisted
        ? [["rollout-destination", resolve(root, descriptor.destinationRollout), false] as const]
        : []),
    ] as const) {
      const bytes = await optionalBytes(path);
      if (bytes !== undefined) entries.push(await store.put(logicalName, bytes, required));
      else if (required) throw new SessionMaintenanceError("BACKUP_INCOMPLETE", `Required Codex file is missing: ${logicalName}`);
    }
    return store.finalize(transaction.id, entries, this.options.now?.().toISOString() ?? new Date().toISOString());
  }

  async commit(prepared: PreparedWrite, transaction: TransactionContext): Promise<WriteReceipt> {
    const descriptor = await this.readDescriptor(transaction.id);
    this.assertScope(prepared, transaction, descriptor);
    const root = this.instanceRoot(prepared);
    await this.assertQuiescent(root);
    await atomicWrite(resolve(root, descriptor.destinationRollout), await readFile(descriptor.candidateRollout));
    this.fault("after-rollout");
    await atomicWrite(join(root, "session_index.jsonl"), await readFile(descriptor.candidateIndex));
    this.fault("after-index");
    await unlink(join(root, "state_5.sqlite-wal")).catch((error) => { if (!isMissing(error)) throw error; });
    await unlink(join(root, "state_5.sqlite-shm")).catch((error) => { if (!isMissing(error)) throw error; });
    await atomicWrite(join(root, "state_5.sqlite"), await readFile(descriptor.candidateDatabase));
    this.fault("after-database");
    if (descriptor.destinationRollout !== descriptor.sourceRollout) {
      await unlink(resolve(root, descriptor.sourceRollout)).catch((error) => { if (!isMissing(error)) throw error; });
    }
    return {
      transactionId: transaction.id,
      platform: "codex",
      instanceId: descriptor.instanceId,
      targetKey: { platform: "codex", instanceId: descriptor.instanceId, sessionId: descriptor.sessionId },
      fingerprints: [targetFingerprint(descriptor.instanceId, descriptor.sessionId, descriptor.rolloutSha256)],
      details: { rolloutSha256: descriptor.rolloutSha256, updatedAtMs: descriptor.updatedAtMs },
    };
  }

  async verify(receipt: WriteReceipt): Promise<VerificationResult> {
    const descriptor = await this.readDescriptor(receipt.transactionId);
    try {
      const rollout = await readFile(resolve(this.instanceRootFromDescriptor(descriptor), descriptor.destinationRollout));
      const ok = hash(rollout) === descriptor.rolloutSha256;
      return { ok, fingerprints: [targetFingerprint(descriptor.instanceId, descriptor.sessionId, hash(rollout))], issues: ok ? [] : [{ code: "VERIFICATION_FAILED", message: "Codex rollout digest mismatch" }] };
    } catch (error) {
      return { ok: false, fingerprints: [], issues: [{ code: "VERIFICATION_FAILED", message: error instanceof Error ? error.message : "Codex verify failed" }] };
    }
  }

  async restore(backup: BackupManifest, transaction: TransactionContext): Promise<RestoreReceipt> {
    const descriptor = await this.readDescriptor(transaction.id);
    const root = this.instanceRootFromDescriptor(descriptor);
    const store = this.store(transaction.id);
    await store.verify(backup);
    const entry = (name: string) => backup.entries.find((item) => item.logicalName === name);
    const restoreEntry = async (name: string, path: string, required: boolean) => {
      const item = entry(name);
      if (item === undefined) {
        if (required) throw new SessionMaintenanceError("BACKUP_INCOMPLETE", `Codex backup entry is missing: ${name}`);
        await unlink(path).catch((error) => { if (!isMissing(error)) throw error; });
        return;
      }
      await atomicWrite(path, await store.get(item));
    };
    await restoreEntry("state_5.sqlite", join(root, "state_5.sqlite"), true);
    await restoreEntry("state_5.sqlite-wal", join(root, "state_5.sqlite-wal"), false);
    await restoreEntry("state_5.sqlite-shm", join(root, "state_5.sqlite-shm"), false);
    await restoreEntry("session_index.jsonl", join(root, "session_index.jsonl"), true);
    if (descriptor.destinationRollout !== descriptor.sourceRollout) {
      await restoreEntry("rollout-destination", resolve(root, descriptor.destinationRollout), false);
    }
    await restoreEntry("rollout-source", resolve(root, descriptor.sourceRollout), true);
    const source = await readFile(resolve(root, descriptor.sourceRollout));
    const original = entry("rollout-source");
    const restored = original !== undefined && hash(source) === original.sha256;
    return { transactionId: transaction.id, restored, fingerprints: [], issues: restored ? [] : [{ code: "RESTORE_FAILED", message: "Codex files did not return to backup digests" }] };
  }

  private contract(version: string, fingerprint = CODEX_SCHEMA_FINGERPRINT) {
    return { adapter: "codex-native", platformVersion: version, schemaFingerprint: fingerprint };
  }

  private async assertQuiescent(root: string): Promise<void> {
    const codexRunning = this.options.codexProcessRunning === undefined
      ? this.options.fixtureGuard === undefined && await defaultCodexProcessRunning()
      : await this.options.codexProcessRunning();
    if (codexRunning) {
      throw new SessionMaintenanceError("CODEX_BUSY", "Codex must be fully closed before native storage maintenance");
    }
    if ((await optionalBytes(join(root, ".dsh-session-maintenance-busy"))) !== undefined) {
      throw new SessionMaintenanceError("CODEX_BUSY", "Codex fixture is marked busy");
    }
    await this.withExclusive(root, async (databasePath) => {
      const watched = [databasePath, `${databasePath}-wal`, join(root, "session_index.jsonl")];
      const before = await Promise.all(watched.map(async (path) => { try { const value = await stat(path, { bigint: true }); return `${value.size}:${value.mtimeNs}`; } catch (error) { if (isMissing(error)) return "missing"; throw error; } }));
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, this.options.quietDelayMs ?? 60));
      const after = await Promise.all(watched.map(async (path) => { try { const value = await stat(path, { bigint: true }); return `${value.size}:${value.mtimeNs}`; } catch (error) { if (isMissing(error)) return "missing"; throw error; } }));
      if (canonicalJson(before) !== canonicalJson(after)) throw new SessionMaintenanceError("CODEX_BUSY", "Codex storage changed during quiescence probe");
    });
  }

  private async withExclusive<T>(
    root: string,
    action: (databasePath: string) => Promise<T>,
    checkpoint = false,
  ): Promise<T> {
    const databasePath = join(root, "state_5.sqlite");
    const database = new DatabaseSync(databasePath, { timeout: 1 });
    try {
      if (checkpoint) database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.exec("BEGIN EXCLUSIVE");
      try { return await action(databasePath); } finally { database.exec("ROLLBACK"); }
    } catch (error) {
      if (String(error).includes("locked") || String(error).includes("busy")) {
        throw new SessionMaintenanceError("CODEX_BUSY", "Codex SQLite database is active", { cause: error });
      }
      throw error;
    } finally { database.close(); }
  }

  private async assertDiskSpace(root: string, payloadBytes: number): Promise<void> {
    const space = await statfs(root);
    const free = Number(space.bavail) * Number(space.bsize);
    const database = await stat(join(root, "state_5.sqlite"));
    if (free < database.size * 2 + payloadBytes * 2 + EXTRA_SPACE_BYTES) {
      throw new SessionMaintenanceError("CODEX_DISK_SPACE_LOW", "Insufficient disk space for Codex candidate and backup");
    }
  }

  private async validateCandidate(descriptor: NativeDescriptor): Promise<void> {
    const database = new DatabaseSync(descriptor.candidateDatabase, { readOnly: true });
    let row: { readonly rollout_path: string; readonly title: string; readonly archived: number } | undefined;
    try { row = database.prepare("SELECT rollout_path, title, archived FROM threads WHERE id = ?").get(descriptor.sessionId) as typeof row; } finally { database.close(); }
    if (row?.rollout_path !== descriptor.destinationRollout || row.title !== descriptor.title || Boolean(row.archived) !== descriptor.archived) {
      throw new SessionMaintenanceError("VERIFICATION_FAILED", "Codex candidate database and rollout metadata disagree");
    }
    const envelopes = parseCodexJsonl(await readFile(descriptor.candidateRollout));
    if (!envelopes.some((item) => item.type === "session_meta" && item.payload.id === descriptor.sessionId)) {
      throw new SessionMaintenanceError("VERIFICATION_FAILED", "Codex candidate rollout lost its session identity");
    }
    const indexLines = (await readFile(descriptor.candidateIndex, "utf8")).trim().split(/\r?\n/u);
    const last = JSON.parse(indexLines.at(-1) ?? "null") as { readonly id?: unknown; readonly thread_name?: unknown } | null;
    if (last?.id !== descriptor.sessionId || last.thread_name !== descriptor.title) {
      throw new SessionMaintenanceError("VERIFICATION_FAILED", "Codex candidate index and thread metadata disagree");
    }
  }

  private descriptorPath(transactionId: string): string { return join(this.options.stateRoot, "transactions", transactionId, "codex-native.json"); }
  private async readDescriptor(transactionId: string): Promise<NativeDescriptor> { return JSON.parse(await readFile(this.descriptorPath(transactionId), "utf8")) as NativeDescriptor; }
  private store(transactionId: string): TransactionBackupStore { return new TransactionBackupStore(join(this.options.stateRoot, "transactions", transactionId)); }
  private instanceRoot(prepared: PreparedWrite): string {
    const configured = this.options.registeredRoots?.get(prepared.instanceId);
    const root = configured ?? this.activeRoots.get(prepared.instanceId);
    if (root === undefined) throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Codex instance root is unavailable");
    return resolve(root);
  }
  private instanceRootFromDescriptor(descriptor: NativeDescriptor): string {
    const root = this.options.registeredRoots?.get(descriptor.instanceId) ?? this.activeRoots.get(descriptor.instanceId);
    if (root === undefined) throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "Codex instance root is unavailable for restore");
    return resolve(root);
  }
  private remember(instance: RegisteredInstance): void {
    const configured = this.options.registeredRoots?.get(instance.id);
    if (configured !== undefined && resolve(configured) !== resolve(instance.root)) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Registered Codex root changed for this adapter");
    }
    this.activeRoots.set(instance.id, instance.root);
  }
  private assertScope(prepared: PreparedWrite, transaction: TransactionContext, descriptor: NativeDescriptor): void {
    if (prepared.platform !== "codex" || prepared.planId !== transaction.planId || prepared.planHash !== transaction.planHash || descriptor.transactionId !== transaction.id || descriptor.planId !== transaction.planId || descriptor.planHash !== transaction.planHash || descriptor.instanceId !== prepared.instanceId || descriptor.sessionId !== prepared.targetKey?.sessionId) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Prepared Codex write escaped transaction scope");
    }
  }
  private fault(point: NonNullable<CodexNativeAdapterOptions["faultAt"]>): void { if (this.options.faultAt === point) throw new Error(`Injected Codex native fault: ${point}`); }
}
