import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MaintenanceWriteEvidence, MaintenanceWriteScope } from "@linmu/dsh-session-contracts";

interface Owner {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly mode: "engine" | "offline";
  readonly createdAt: string;
}
interface Context {
  active: boolean;
  accepting: boolean;
  readonly scope: string;
  readonly children: Set<Promise<unknown>>;
  childTail: Promise<unknown>;
  readonly synchronous?: boolean;
}
const OWNER = "maintenance-writer.json";
const RECOVERY = "maintenance-writer-recovery.json";
const localOwners = new Map<string, MaintenanceWriteCoordinator>();

function parseOwner(path: string): Owner {
  const value = JSON.parse(readFileSync(path, "utf8")) as Owner;
  if (value.schemaVersion !== 1 || typeof value.ownerId !== "string" || !/^[a-f0-9-]{36}$/u.test(value.ownerId) || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.hostname !== "string" || !["engine", "offline"].includes(value.mode)) throw new Error("WRITER_OWNER_UNKNOWN");
  return value;
}
function writeExclusive(path: string, owner: Owner): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
}
function assertDead(owner: Owner): void {
  if (owner.hostname !== hostname()) throw new Error("WRITER_OWNER_UNKNOWN: owner is on another host");
  try { process.kill(owner.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error("WRITER_OWNER_UNKNOWN: cannot verify owner process", { cause: error });
  }
  throw new Error("WRITER_OWNER_ACTIVE: the owner process still exists");
}

/** Cooperative process ownership plus a bounded, reentrant application write queue.
 * Age is never proof of process death. Unrecognized external writers or recovery
 * markers require investigation; this protocol does not override arbitrary SQLite writers.
 */
export class MaintenanceWriteCoordinator implements MaintenanceWriteScope {
  private readonly context = new AsyncLocalStorage<Context>();
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private current: Context | undefined;
  private generation = 0;
  private closed = false;

  private constructor(readonly stateRoot: string, private readonly owner: Owner, private readonly maxPending: number) {}

  static acquire(stateRoot: string, mode: Owner["mode"] = "engine", options: { readonly maxPending?: number } = {}): MaintenanceWriteCoordinator {
    const maxPending = options.maxPending ?? 1024;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError("Invalid write queue limit");
    mkdirSync(stateRoot, { recursive: true });
    const root = realpathSync(stateRoot);
    for (let parent = dirname(root); ; parent = dirname(parent)) {
      if (existsSync(join(parent, OWNER)) || existsSync(join(parent, "connection.json"))) throw new Error("WRITER_OWNER_CONFLICT: nested state root is already covered");
      if (parent === dirname(parent)) break;
    }
    if (existsSync(join(root, RECOVERY))) throw new Error("WRITER_RECOVERY_REQUIRED");
    // A legacy connection with no cooperating owner cannot prove offline safety.
    if (existsSync(join(root, "connection.json")) && !existsSync(join(root, OWNER))) throw new Error("WRITER_OWNER_UNKNOWN: unowned Engine connection");
    const owner: Owner = { schemaVersion: 1, ownerId: randomUUID(), pid: process.pid, hostname: hostname(), mode, createdAt: new Date().toISOString() };
    try { writeExclusive(join(root, OWNER), owner); } catch (error) {
      throw new Error("WRITER_OWNER_CONFLICT: inspect the existing owner; recovery requires proven process death", { cause: error });
    }
    if (existsSync(join(root, RECOVERY))) {
      unlinkSync(join(root, OWNER));
      throw new Error("WRITER_RECOVERY_REQUIRED");
    }
    const coordinator = new MaintenanceWriteCoordinator(root, owner, maxPending);
    localOwners.set(root, coordinator);
    return coordinator;
  }

  static inspect(stateRoot: string): Owner { return parseOwner(join(realpathSync(stateRoot), OWNER)); }

  static recoverDeadOwner(stateRoot: string, expectedOwnerId: string): void {
    const root = realpathSync(stateRoot);
    const gate: Owner = { schemaVersion: 1, ownerId: randomUUID(), pid: process.pid, hostname: hostname(), mode: "offline", createdAt: new Date().toISOString() };
    writeExclusive(join(root, RECOVERY), gate);
    try {
      const owner = parseOwner(join(root, OWNER));
      if (owner.ownerId !== expectedOwnerId) throw new Error("WRITER_OWNER_CHANGED");
      assertDead(owner);
      const connection = join(root, "connection.json");
      if (existsSync(connection)) {
        const descriptor = JSON.parse(readFileSync(connection, "utf8")) as { ownerId?: string; pid?: number };
        if (descriptor.ownerId !== owner.ownerId || descriptor.pid !== owner.pid) throw new Error("WRITER_OWNER_UNKNOWN: connection ownership differs");
        renameSync(connection, join(root, `connection.dead-${owner.ownerId}.json`));
      }
      // Preserve crash evidence. The recovery gate prevents another cooperating
      // recovery/start from replacing the record between verification and rename.
      renameSync(join(root, OWNER), join(root, `maintenance-writer.dead-${owner.ownerId}.json`));
    } finally { unlinkSync(join(root, RECOVERY)); }
  }

  private assertOwner(): void {
    if (this.closed || parseOwner(join(this.stateRoot, OWNER)).ownerId !== this.owner.ownerId) throw new Error("WRITER_OWNER_LOST");
  }

  run<T>(scope: string, operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const inherited = this.context.getStore();
    if (inherited !== undefined) {
      if (!inherited.active) return this.context.exit(() => this.run(scope, operation, signal));
      if (!inherited.accepting) return Promise.reject(new Error("WRITER_SCOPE_EXPIRED"));
      if (inherited.synchronous) return Promise.reject(new Error("WRITER_SYNC_ASYNC: use run() for asynchronous mutations"));
      if (inherited.children.size >= this.maxPending) return Promise.reject(new Error("WRITER_QUEUE_FULL: too many sibling mutations"));
      this.assertOwner();
      // Each node serializes siblings on its own tail. A child gets a fresh
      // node for descendants, so awaiting a nested Store mutation cannot wait
      // on its own parent (the deadlock caused by one shared nested tail).
      const child = inherited.childTail.then(async () => {
        signal?.throwIfAborted(); this.assertOwner();
        const context: Context = { active: true, accepting: true, scope, children: new Set(), childTail: Promise.resolve() };
        try {
          return await this.context.run(context, async () => {
            try { return await operation(); } finally {
              context.accepting = false;
              await Promise.allSettled(context.children);
            }
          });
        } finally { context.active = false; }
      });
      inherited.childTail = child.catch(() => undefined);
      inherited.children.add(child);
      // Handle rejection immediately even when a caller neglects to await it.
      void child.then(() => inherited.children.delete(child), () => inherited.children.delete(child));
      return child;
    }
    if (this.pending >= this.maxPending) return Promise.reject(new Error("WRITER_QUEUE_FULL: retry after pending commits drain"));
    this.pending += 1;
    let started = false;
    const work = this.tail.then(async () => {
      signal?.throwIfAborted();
      started = true;
      this.assertOwner();
      const context: Context = { active: true, accepting: true, scope, children: new Set(), childTail: Promise.resolve() };
      this.current = context;
      this.generation += 1;
      try {
        return await this.context.run(context, async () => {
          let result: T;
          try { result = await operation(); } finally {
            context.accepting = false;
            await Promise.allSettled(context.children);
          }
          return result;
        });
      } finally {
        context.active = false;
        this.current = undefined;
        this.generation += 1;
      }
    }).finally(() => { this.pending -= 1; });
    this.tail = work.catch(() => undefined);
    // Cancellation of a queued request is observable immediately. Its queue slot
    // will later skip operation, so it cannot perform a delayed cancelled write.
    if (signal === undefined) return work;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => { if (!started) reject(signal.reason); };
      signal.addEventListener("abort", cancel, { once: true });
      void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }

  runSync<T>(scope: string, operation: () => T): T {
    this.assertOwner();
    const inherited = this.context.getStore();
    if (inherited !== undefined) {
      if (!inherited.active || !inherited.accepting) throw new Error("WRITER_SCOPE_EXPIRED");
      if (inherited.children.size > 0) throw new Error("WRITER_BUSY: await asynchronous child mutations before a synchronous sibling");
    }
    if (inherited === undefined && this.pending !== 0) throw new Error("WRITER_BUSY: schedule this mutation with run()");
    const context: Context = { active: true, accepting: true, synchronous: true, scope, children: new Set(), childTail: Promise.resolve() };
    if (inherited === undefined) { this.current = context; this.generation += 1; }
    try {
      const result = this.context.run(context, operation);
      if (result !== null && typeof result === "object" && "then" in result) throw new Error("WRITER_SYNC_ASYNC: synchronous operation returned a promise");
      return result;
    } finally {
      context.active = false;
      context.accepting = false;
      if (inherited === undefined) { this.current = undefined; this.generation += 1; }
    }
  }

  assertInScope(): void {
    this.assertOwner();
    const context = this.context.getStore();
    if (context === undefined || !context.active || !context.accepting) throw new Error("WRITER_SCOPE_REQUIRED");
  }
  captureEvidence(): MaintenanceWriteEvidence {
    this.assertOwner();
    return { schemaVersion: 1, ownerId: this.owner.ownerId, stateRoot: this.stateRoot, generation: this.generation, activeScope: this.current?.scope ?? null };
  }
  assertEvidence(evidence: MaintenanceWriteEvidence): void {
    this.assertInScope();
    const current = this.captureEvidence();
    if (evidence.ownerId !== current.ownerId || evidence.stateRoot !== current.stateRoot || evidence.generation !== current.generation) throw new Error("WRITER_EVIDENCE_CHANGED");
  }
  async drain(): Promise<void> { await this.tail; }
  assertIdle(): void {
    if (this.pending !== 0 || this.current !== undefined) throw new Error("WRITER_BUSY: drain before closing");
  }
  close(): void {
    if (this.closed) return;
    this.assertIdle();
    this.assertOwner();
    unlinkSync(join(this.stateRoot, OWNER));
    localOwners.delete(this.stateRoot);
    this.closed = true;
  }
}

/** Refuse legacy/direct writable opens against another live or unknown owner.
 * Call before any mkdir, PRAGMA or schema migration. Read-only tools should use
 * DatabaseSync({readOnly:true}) and must never route through a migrating opener.
 */
export function assertMaintenanceDatabaseOwnership(path: string): void {
  let directory = dirname(resolve(path));
  while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
  for (let root = realpathSync(directory); ; root = dirname(root)) {
    if (existsSync(join(root, OWNER))) {
      const coordinator = localOwners.get(root);
      if (coordinator === undefined) throw new Error("WRITER_OWNER_CONFLICT: use the online Engine API");
      coordinator.captureEvidence(); return;
    }
    if (existsSync(join(root, "connection.json"))) throw new Error("WRITER_OWNER_UNKNOWN: refusing a migrating database open");
    if (root === dirname(root)) return;
  }
}

/** Standalone maintenance operations hold ownership over backup/object creation,
 * candidate registration and pointer activation, including their final awaits. */
export function offlineMaintenanceOperation<I extends { readonly stateRoot: string }, O>(
  operation: (input: I) => Promise<O>, scope: string,
): (input: I) => Promise<O> {
  return async (input) => {
    // Engine-owned callers reuse that process's queue. A separate offline process
    // has no entry in this registry and must acquire the exclusive owner below.
    const root = existsSync(input.stateRoot) ? realpathSync(input.stateRoot) : resolve(input.stateRoot);
    const existing = localOwners.get(root);
    if (existing !== undefined) return existing.run(scope, () => operation(input));
    const writes = MaintenanceWriteCoordinator.acquire(input.stateRoot, "offline");
    try { return await writes.run(scope, () => operation(input)); } finally { await writes.drain(); writes.close(); }
  };
}

/** Explicit scheduling at application boundaries; listed methods must return promises. */
export function coordinateAsyncMethods<T extends object>(target: T, names: readonly (keyof T)[], writes: MaintenanceWriteScope, scope: string): T {
  for (const name of names) {
    const method = target[name];
    if (typeof method !== "function") throw new TypeError(`Not a method: ${String(name)}`);
    Object.defineProperty(target, name, { configurable: true, writable: true, value: (...args: unknown[]) => writes.run(scope, () => method.apply(target, args)) });
  }
  return target;
}

export function coordinateSyncMethods<T extends object>(target: T, names: readonly (keyof T)[], writes: MaintenanceWriteScope, scope: string): T {
  for (const name of names) {
    const method = target[name];
    if (typeof method !== "function") throw new TypeError(`Not a method: ${String(name)}`);
    Object.defineProperty(target, name, { configurable: true, writable: true, value: (...args: unknown[]) => writes.runSync(scope, () => method.apply(target, args)) });
  }
  return target;
}
