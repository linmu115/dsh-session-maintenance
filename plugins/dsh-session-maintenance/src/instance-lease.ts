import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  instanceLeaseSchema, instanceLivenessAnswerSchema, instanceLivenessChallengeSchema,
  type InstanceLease, type InstanceLeaseState,
} from '@linmu/dsh-session-contracts';
// The lease file layer is Node-only and deliberately outside the browser-safe barrel.
import { writeInstanceLease } from '@linmu/dsh-session-contracts/instance-lease-file';

/**
 * The instance half of the takeover handshake.
 *
 * The user may start the instance before the Maintenance Engine exists, so the
 * instance cannot wait for instructions. It writes down what it is and where its
 * runtime listens, and keeps doing so while it runs; the Engine picks that up
 * whenever it appears. Everything here is deliberately about *stating* the
 * instance, never about deciding a takeover: the Engine owns the run, the
 * runtime client id and the scope.
 */

const MAX_REQUEST_BYTES = 8 * 1024;

export interface InstanceLeaseIdentity {
  readonly instanceId: string;
  readonly profileId: string;
  readonly homeRoot: string;
  /** `null` when this process does not know its own web port; the Engine reads the configuration instead. */
  readonly runtimeUrl: string | null;
  readonly pid: number;
  readonly processStartedAt: string;
}

/** Read the OS process start time once: it is what makes a stale PID detectable. */
export function processStartedAtFrom(evidence: { readonly process: { readonly startedAt: string } | null }): string | null {
  return evidence.process?.startedAt ?? null;
}

/**
 * Ask the operating system when this process started.
 *
 * The Engine re-checks this value, so it has to be the OS's own answer rather
 * than the process's own uptime; a reused process id is only detectable when
 * both sides read the same clock. Windows only, because this product is.
 */
export async function currentProcessStartedAt(pid: number = process.pid,
  execute: typeof execFile = execFile): Promise<string | null> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) return null;
  const script = `$ErrorActionPreference='Stop'; $item=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; `
    + `if($null -eq $item){''}else{$item.CreationDate.ToUniversalTime().ToString('o')}`;
  try {
    const { stdout } = await promisify(execute)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4_096 });
    const startedAt = String(stdout).trim();
    return Number.isFinite(Date.parse(startedAt)) ? startedAt : null;
  } catch { return null; }
}

/**
 * The DSH Home this instance is running from.
 *
 * `DSH_HOME` is the host's own answer to that question, and it is the folder the
 * Engine's directory connection selects, so the two sides agree on the identity
 * without a new configuration surface. A process without it cannot state which
 * instance it is, and must not publish a lease that would be refused anyway.
 */
export function instanceHomeRoot(environment: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const home = environment.DSH_HOME?.trim();
  return home === undefined || home.length === 0 ? undefined : home;
}

/**
 * Where this instance's runtime listens, when the host happens to state it.
 *
 * This is an optional override, never a requirement: the host does not tell a
 * plugin which port it was started on, and the Engine reads the port out of the
 * instance's own configuration instead. The instance therefore reports only what
 * it necessarily knows, and a lease is written just the same without this.
 */
export function instanceRuntimeUrl(environment: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = environment.DSH_SESSION_MAINTENANCE_RUNTIME_URL?.trim();
  if (value === undefined || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.origin : null;
  } catch { return null; }
}

/**
 * Everything the lease needs, or `null` when this instance cannot state its own
 * identity. `runtimeUrl` may be `null`: the Engine resolves the endpoint from the
 * instance's own configuration when the instance itself does not know it, so an
 * instance never has to be told its own port to be discoverable.
 */
export async function instanceLeaseIdentity(input: {
  readonly instanceId: string;
  readonly profileId: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly startedAt?: () => Promise<string | null>;
}): Promise<InstanceLeaseIdentity | null> {
  const environment = input.environment ?? process.env;
  const homeRoot = instanceHomeRoot(environment);
  const processStartedAt = await (input.startedAt ?? currentProcessStartedAt)();
  if (homeRoot === undefined || processStartedAt === null) return null;
  return { instanceId: input.instanceId, profileId: input.profileId, homeRoot,
    runtimeUrl: instanceRuntimeUrl(environment), pid: process.pid, processStartedAt };
}

/**
 * The lease this process would publish right now. `pid` and the process start
 * time are the instance's own; the Engine re-checks both against the OS before
 * it trusts anything.
 */
export function instanceLeaseFor(identity: InstanceLeaseIdentity, state: InstanceLeaseState, attachedRunId: string | null,
  clock: () => string = () => new Date().toISOString()): InstanceLease {
  return instanceLeaseSchema.parse({ schemaVersion: 1, instanceId: identity.instanceId, profileId: identity.profileId,
    pid: identity.pid, processStartedAt: identity.processStartedAt, homeRoot: identity.homeRoot, runtimeUrl: identity.runtimeUrl,
    state, attachedRunId, updatedAt: clock() });
}

/**
 * Keeps the published lease current.
 *
 * The lease is written once at startup and then only when something actually
 * changed, because the Engine may read it at any moment and a half-written file
 * must never be observable. Writing is best-effort: an instance that cannot
 * write its lease still runs, it simply cannot be discovered.
 */
export class InstanceLeasePublisher {
  private state: InstanceLeaseState = 'idle';
  private attachedRunId: string | null = null;
  private lastWritten: string | undefined;
  private reported: string | undefined;

  constructor(private readonly identityValue: InstanceLeaseIdentity, private readonly write: (lease: InstanceLease) => Promise<unknown>,
    private readonly onFailure: (message: string) => void = () => undefined,
    private readonly clock: () => string = () => new Date().toISOString()) {}

  /** The identity this lease states; the liveness endpoint answers from the same one. */
  get identity(): InstanceLeaseIdentity { return this.identityValue; }

  async publish(state: InstanceLeaseState = this.state, attachedRunId: string | null = this.attachedRunId): Promise<void> {
    this.state = state; this.attachedRunId = attachedRunId;
    const lease = instanceLeaseFor(this.identityValue, state, attachedRunId, this.clock);
    const rendered = JSON.stringify(lease);
    if (rendered === this.lastWritten) return;
    try { await this.write(lease); this.lastWritten = rendered; }
    catch (error) {
      const message = `[dsh-session-maintenance] 实例握手未能写入：${error instanceof Error ? error.message : String(error)}`;
      if (message !== this.reported) { this.reported = message; this.onFailure(message); }
    }
  }

  /** The instance is going away; the Engine must not treat the file as a live offer. */
  async stopping(): Promise<void> { await this.publish('stopping', this.attachedRunId); }

  current(): { readonly state: InstanceLeaseState; readonly attachedRunId: string | null } {
    return { state: this.state, attachedRunId: this.attachedRunId };
  }
}

/**
 * Publish this instance's handshake using the state root the Engine will read.
 *
 * Returns `null` when the instance cannot state its identity or cannot locate
 * the state root: those are both normal situations (no installer registration,
 * no `DSH_HOME`), and neither may stop the instance from running. Writing is
 * best effort for the same reason — an instance that cannot be discovered still
 * works, it just cannot be taken over.
 */
export async function startInstanceLease(input: {
  readonly instanceId: string;
  readonly profileId: string;
  readonly stateRoot: string | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly startedAt?: () => Promise<string | null>;
  readonly write?: (stateRoot: string, lease: InstanceLease) => Promise<unknown>;
  readonly report?: (message: string) => void;
  readonly clock?: () => string;
}): Promise<InstanceLeasePublisher | null> {
  if (input.stateRoot === undefined) return null;
  const identity = await instanceLeaseIdentity({ instanceId: input.instanceId, profileId: input.profileId,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }) });
  if (identity === null) return null;
  const stateRoot = input.stateRoot;
  const publisher = new InstanceLeasePublisher(identity,
    lease => (input.write ?? writeInstanceLease)(stateRoot, lease),
    input.report ?? (() => undefined), input.clock ?? (() => new Date().toISOString()));
  await publisher.publish();
  return publisher;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new TypeError('握手请求过大');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The endpoint the Engine calls to prove it is talking to the instance it thinks
 * it is. The answer restates this process's own identity; a challenge naming
 * anything else is answered with `matched: false` rather than an error, so the
 * Engine can distinguish "wrong instance" from "not an instance at all".
 */
export function createInstanceLeaseHandler(input: {
  readonly identity: InstanceLeaseIdentity;
  readonly publisher: Pick<InstanceLeasePublisher, 'current'>;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (request.method !== 'POST') { sendJson(response, 405, { error: 'Use POST for the instance liveness challenge' }); return; }
    let parsed;
    try { parsed = instanceLivenessChallengeSchema.safeParse(await readJson(request)); }
    catch { sendJson(response, 400, { error: 'The liveness challenge is not readable' }); return; }
    if (!parsed.success) { sendJson(response, 400, { error: 'The liveness challenge is not a supported request' }); return; }
    const challenge = parsed.data;
    const { instanceId, profileId, homeRoot, pid } = input.identity;
    const current = input.publisher.current();
    sendJson(response, 200, instanceLivenessAnswerSchema.parse({
      schemaVersion: 1, responder: 'dsh-session-maintenance', instanceId, profileId,
      matched: challenge.instanceId === instanceId && challenge.profileId === profileId
        && challenge.pid === pid && challenge.homeRoot === homeRoot,
      pid, homeRoot, state: current.state, attachedRunId: current.attachedRunId,
    }));
  };
}
