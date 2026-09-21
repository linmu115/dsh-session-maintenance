import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  instanceLeasePath, readInstanceLease as readSharedLease, takeoverHandoffSchema,
  type TakeoverHandoff,
} from '@linmu/dsh-session-contracts';
import {
  instanceLeaseInspectionSchema, instanceLivenessAnswerSchema, instanceLivenessChallengeSchema,
  instanceSyncDecisionResponseSchema, instanceSyncRequestSchema,
  type InstanceLeaseInspection, type InstanceLivenessAnswer,
} from '@linmu/dsh-session-contracts';
import { recoverySystemEvidence } from './lifecycle-recovery.js';

/**
 * A handshake the Engine owns and the instance writes.
 *
 * The Engine may be absent while an instance runs, so the instance records what
 * it is and where its runtime listens, and the Engine reads that when it
 * appears. The file lives under the Engine state root because that is the only
 * directory both sides already agree on, and it is named after the instance so
 * a takeover can find it without a scan. The file layer itself is shared with
 * the instance side; see `@linmu/dsh-session-contracts`.
 */
export {
  INSTANCE_LEASE_DIRECTORY, instanceLeasePath, listInstanceLeases, readInstanceLease, removeInstanceLease, writeInstanceLease,
} from '@linmu/dsh-session-contracts';

/**
 * Judge one instance's lease.
 *
 * The Engine never trusts the file: it confirms through the OS that the process
 * the lease names is still the same process, so a reused PID or a leftover file
 * after a crash reads as `stale` instead of being taken over. `expected` lets a
 * caller tie the lease to the folder the operator selected, so a lease that
 * belongs to another Home cannot be used to take over this instance.
 */
async function readRawLease(stateRoot: string, instanceId: string, profileId: string): Promise<unknown> {
  try { return JSON.parse(await readFile(instanceLeasePath(stateRoot, instanceId, profileId), 'utf8')); }
  catch { return undefined; }
}

/**
 * The web endpoint an instance listens on, read from its own configuration.
 *
 * The host does not tell a plugin which port it was started on, so the plugin
 * cannot be the only source of that answer. The instance *does* state it in the
 * profile's `cordis.patch.yml`, which the Engine already reads for the identity
 * and the integration settings, so the port is taken from there — the host and
 * the user's own configuration remain the authority, not a new variable.
 */
export async function configuredRuntimeUrl(profileRoot: string): Promise<string | null> {
  const text = await readFile(join(profileRoot, 'cordis.patch.yml'), 'utf8').catch(() => undefined);
  if (text === undefined) return null;
  const document = parseDocument(text);
  if (document.errors.length > 0) return null;
  const layers = document.toJS({ maxAliasCount: 50 });
  const visit = (value: unknown): string | null => {
    if (Array.isArray(value)) { for (const item of value) { const found = visit(item); if (found !== null) return found; } return null; }
    if (typeof value !== 'object' || value === null) return null;
    const record = value as { id?: unknown; name?: unknown; config?: { port?: unknown } };
    const isWebserver = record.id === 'webserver' || record.name === '@deepseek-ai/dsh-webserver';
    const port = record.config?.port;
    if (isWebserver && typeof port === 'number' && Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
    for (const nested of Object.values(value)) { const found = visit(nested); if (found !== null) return found; }
    return null;
  };
  return visit(layers);
}

/** Where an endpoint came from, so a missing one is reported instead of assumed. */
async function resolveRuntimeEndpoint(lease: { readonly runtimeUrl: string | null }, profileRoot: string | null | undefined):
Promise<{ readonly runtimeUrl: string | null; readonly runtimeUrlSource: 'instance' | 'configuration' | 'none' }> {
  if (lease.runtimeUrl !== null) return { runtimeUrl: lease.runtimeUrl, runtimeUrlSource: 'instance' };
  if (profileRoot === null || profileRoot === undefined) return { runtimeUrl: null, runtimeUrlSource: 'none' };
  const configured = await configuredRuntimeUrl(profileRoot);
  return configured === null ? { runtimeUrl: null, runtimeUrlSource: 'none' }
    : { runtimeUrl: configured, runtimeUrlSource: 'configuration' };
}

export async function inspectInstanceLease(stateRoot: string, input: {
  readonly instanceId: string;
  readonly profileId: string;
  /** The DSH Home the operator selected, when the caller has one. */
  readonly expectedHomeRoot?: string;
  /** The profile whose configuration names the instance's web port, when the caller knows it. */
  readonly profileRoot?: string | null;
  /** OS process evidence; injectable so the decision can be tested without a real instance. */
  readonly processEvidence?: typeof recoverySystemEvidence;
}): Promise<InstanceLeaseInspection> {
  const base = { instanceId: input.instanceId, profileId: input.profileId };
  const parsedLease = await readSharedLease(stateRoot, input.instanceId, input.profileId);
  const raw = await readRawLease(stateRoot, input.instanceId, input.profileId);
  if (raw === undefined) {
    // No lease means the instance never announced itself, so there is nothing to
    // confirm; a configured port alone is not evidence that anything is running.
    const configured = input.profileRoot === null || input.profileRoot === undefined ? null : await configuredRuntimeUrl(input.profileRoot);
    return instanceLeaseInspectionSchema.parse({ ...base, homeRoot: input.expectedHomeRoot ?? '', runtimeUrl: configured,
      runtimeUrlSource: configured === null ? 'none' : 'configuration',
      process: null, state: null, attachedRunId: null, decision: 'absent', reason: '实例还没有留下握手；它可能尚未运行，或尚未加载接入插件。' });
  }
  if (parsedLease === undefined) {
    return instanceLeaseInspectionSchema.parse({ ...base, homeRoot: input.expectedHomeRoot ?? '', runtimeUrl: null,
      runtimeUrlSource: 'none', process: null, state: null, attachedRunId: null, decision: 'stale',
      reason: '实例握手文件无法识别，已忽略；请重启该实例后重试。' });
  }
  const lease = parsedLease;
  const endpoint = await resolveRuntimeEndpoint(lease, input.profileRoot);
  // A stale or unconfirmed lease never gets to pick the endpoint: that answer has
  // to come from the configuration, so a leftover file cannot redirect a request.
  const configuredOnly = await (async () => input.profileRoot === null || input.profileRoot === undefined
    ? { runtimeUrl: null, runtimeUrlSource: 'none' as const }
    : { runtimeUrl: await configuredRuntimeUrl(input.profileRoot), runtimeUrlSource: 'configuration' as const })();
  const stale = (reason: string) => instanceLeaseInspectionSchema.parse({ ...base, homeRoot: lease.homeRoot,
    runtimeUrl: configuredOnly.runtimeUrl, runtimeUrlSource: configuredOnly.runtimeUrl === null ? 'none' : 'configuration',
    process: null, state: lease.state, attachedRunId: lease.attachedRunId, decision: 'stale', reason });
  if (lease.instanceId !== input.instanceId || lease.profileId !== input.profileId)
    return stale('握手文件中的实例标识与请求不一致，已忽略。');
  if (input.expectedHomeRoot !== undefined && lease.homeRoot !== input.expectedHomeRoot)
    return stale('握手属于另一个 DSH Home，与所选文件夹不一致，已忽略。');

  // The instance states its own process; the OS decides whether that is true.
  let process: { pid: number; startedAt: string } | null = null;
  try {
    const evidence = await (input.processEvidence ?? recoverySystemEvidence)(lease.pid);
    if (evidence.process !== null && evidence.process.startedAt === lease.processStartedAt) process = { pid: evidence.process.pid, startedAt: evidence.process.startedAt };
  } catch {
    // No OS evidence means no takeover; the lease itself is still reported.
    return instanceLeaseInspectionSchema.parse({ ...base, homeRoot: lease.homeRoot, ...configuredOnly,
      process: null, state: lease.state, attachedRunId: lease.attachedRunId, decision: 'not-running',
      reason: '无法核实此实例的进程身份，未接管；实例仍处于运行中时会重新留下握手。' });
  }
  if (process === null) {
    return instanceLeaseInspectionSchema.parse({ ...base, homeRoot: lease.homeRoot, ...configuredOnly,
      process: null, state: lease.state, attachedRunId: lease.attachedRunId, decision: 'not-running',
      reason: lease.state === 'stopping' ? '实例正在退出，等它重新启动后再接管。' : '握手中登记的进程已不在，实例可能已退出。' });
  }
  return instanceLeaseInspectionSchema.parse({ ...base, homeRoot: lease.homeRoot, ...endpoint,
    process, state: lease.state, attachedRunId: lease.attachedRunId, decision: 'running',
    reason: lease.attachedRunId === null
      ? (endpoint.runtimeUrlSource === 'none'
        ? '已确认实例正在运行，但拿不到它的 Web 端口；无法向它发出同步请求。'
        : '已确认实例正在运行，可以接管。')
      : '实例正在运行，但已附着到一个运行；接管前需要先恢复该运行。' });
}

/**
 * Ask the instance to prove it is the instance the lease names.
 *
 * This is what makes a takeover about a *real running instance* rather than a
 * file: the endpoint must answer with the same identity, the same Home and the
 * same OS process. Any refusal — unreachable, wrong shape, different identity —
 * is reported as a refusal and never repaired into a takeover.
 */
export async function challengeInstanceLiveness(input: {
  readonly runtimeUrl: string;
  readonly instanceId: string;
  readonly profileId: string;
  readonly pid: number;
  readonly homeRoot: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<{ readonly answered: true; readonly answer: InstanceLivenessAnswer } | { readonly answered: false; readonly reason: string }> {
  const challenge = instanceLivenessChallengeSchema.parse({ schemaVersion: 1, instanceId: input.instanceId,
    profileId: input.profileId, pid: input.pid, homeRoot: input.homeRoot });
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${input.runtimeUrl}/dsh-session-maintenance/instance/lease`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(challenge), signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
    });
  } catch (error) {
    return { answered: false, reason: `实例的运行时端点在 ${input.runtimeUrl} 上没有应答：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { answered: false, reason: `实例的运行时端点以 ${response.status} 拒绝了握手核对。` };
  const parsed = instanceLivenessAnswerSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return { answered: false, reason: '实例的应答不是受支持的握手格式，已拒绝接管。' };
  const answer = parsed.data;
  if (answer.instanceId !== input.instanceId || answer.profileId !== input.profileId)
    return { answered: false, reason: '应答的实例标识与所选实例不一致，已拒绝接管。' };
  if (answer.homeRoot !== input.homeRoot) return { answered: false, reason: '应答的 DSH Home 与所选文件夹不一致，已拒绝接管。' };
  if (answer.pid !== input.pid) return { answered: false, reason: '应答的进程与握手登记的进程不一致，已拒绝接管。' };
  if (!answer.matched) return { answered: false, reason: '实例自己否认了这次握手核对，已拒绝接管。' };
  return { answered: true, answer };
}

export const TAKEOVER_HANDOFF_DIRECTORY = 'takeovers';

/** The handoff for one takeover ticket. One file per ticket, so a stale ticket cannot be reused. */
export function takeoverHandoffPath(stateRoot: string, ticketId: string): string {
  return join(stateRoot, TAKEOVER_HANDOFF_DIRECTORY, `${ticketId}.json`);
}

/**
 * Publish what the instance needs in order to attach to an Engine-prepared run.
 *
 * The Engine has already prepared the run — it owns Canonical state and freezes
 * the scope — so this file only carries the handoff: where to attach, which
 * capability proves this run, and which persistence root the run expects. It is
 * written atomically because the instance may read it at any moment.
 */
export async function writeTakeoverHandoff(stateRoot: string, handoff: TakeoverHandoff): Promise<string> {
  const parsed = takeoverHandoffSchema.parse(handoff);
  const path = takeoverHandoffPath(stateRoot, parsed.ticketId);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(join(stateRoot, TAKEOVER_HANDOFF_DIRECTORY), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(parsed)}\n`, 'utf8');
  await rename(temporary, path);
  return path;
}

/**
 * Let an instance claim a prepared run exactly once.
 *
 * The ticket is the capability: only a process that can read the Engine's own
 * state root can present it, which is the same trust level as the connection
 * descriptor. A claim names the claiming process, the ticket is marked claimed
 * before the details are returned, and a second claim is refused rather than
 * handing the same run to two processes — the run itself is single-attach and
 * the refusal has to come from here, not from an attach failure later.
 */
export async function claimTakeoverHandoff(stateRoot: string, input: {
  readonly ticketId: string;
  readonly instanceId: string;
  readonly profileId: string;
  readonly pid: number;
  readonly now?: string;
}): Promise<{ readonly claimed: true; readonly handoff: TakeoverHandoff } | { readonly claimed: false; readonly reason: string }> {
  const path = takeoverHandoffPath(stateRoot, input.ticketId);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch { return { claimed: false, reason: '接管票据不存在或不可读；请重新发起接管。' }; }
  const parsed = takeoverHandoffSchema.safeParse(raw);
  if (!parsed.success) return { claimed: false, reason: '接管票据无法识别，已忽略。' };
  const handoff = parsed.data;
  if (handoff.instanceId !== input.instanceId || handoff.profileId !== input.profileId)
    return { claimed: false, reason: '票据属于另一个实例，已拒绝。' };
  if (handoff.claimedAt !== null) return { claimed: false, reason: '该接管票据已被领取，请重新发起接管。' };
  const claimed: TakeoverHandoff = { ...handoff, claimedAt: input.now ?? new Date().toISOString() };
  await writeTakeoverHandoff(stateRoot, claimed);
  return { claimed: true, handoff: claimed };
}

/** Open takeover tickets, so a restart can show what is still waiting for an instance. */
export async function listTakeoverHandoffs(stateRoot: string): Promise<readonly TakeoverHandoff[]> {
  const directory = join(stateRoot, TAKEOVER_HANDOFF_DIRECTORY);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const handoffs: TakeoverHandoff[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = takeoverHandoffSchema.safeParse(await readJsonFile(join(directory, entry.name)));
    if (parsed.success) handoffs.push(parsed.data);
  }
  return handoffs;
}

async function readJsonFile(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return undefined; }
}

export const SYNC_REQUEST_DIRECTORY = 'sync-requests';

export interface StoredSyncRequest {
  readonly request: import('@linmu/dsh-session-contracts').InstanceSyncRequest;
  /** `null` while the user has not answered; a decision is final. */
  readonly decision: import('@linmu/dsh-session-contracts').InstanceSyncDecisionResponse | null;
}

export function syncRequestPath(stateRoot: string, requestId: string): string {
  return join(stateRoot, SYNC_REQUEST_DIRECTORY, `${requestId}.json`);
}

/**
 * Record a synchronisation the Engine wants the instance's user to approve.
 *
 * The Engine cannot perform this itself for an already running instance, so it
 * writes down the request and waits. A request is deliberately separate from the
 * takeover ticket: a run can be prepared and still be refused by the user.
 */
export async function writeSyncRequest(stateRoot: string, request: import('@linmu/dsh-session-contracts').InstanceSyncRequest): Promise<string> {
  const path = syncRequestPath(stateRoot, request.requestId);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(join(stateRoot, SYNC_REQUEST_DIRECTORY), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ request, decision: null } satisfies StoredSyncRequest)}\n`, 'utf8');
  await rename(temporary, path);
  return path;
}

export async function readSyncRequest(stateRoot: string, requestId: string): Promise<StoredSyncRequest | undefined> {
  const raw = await readJsonFile(syncRequestPath(stateRoot, requestId));
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as { request?: unknown; decision?: unknown };
  const request = instanceSyncRequestSchema.safeParse(record.request);
  if (!request.success) return undefined;
  const decision = record.decision === null || record.decision === undefined ? null : instanceSyncDecisionResponseSchema.safeParse(record.decision);
  return { request: request.data, decision: decision !== null && decision.success ? decision.data : null };
}

/** Requests this instance has not answered yet; that is exactly what it is asked to show. */
export async function listPendingSyncRequests(stateRoot: string, instanceId: string, profileId: string): Promise<readonly StoredSyncRequest[]> {
  const directory = join(stateRoot, SYNC_REQUEST_DIRECTORY);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const pending: StoredSyncRequest[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const stored = await readSyncRequest(stateRoot, entry.name.slice(0, -'.json'.length));
    if (stored === undefined || stored.decision !== null) continue;
    if (stored.request.instanceId !== instanceId || stored.request.profileId !== profileId) continue;
    pending.push(stored);
  }
  return pending;
}

/**
 * Record the user's answer. The first answer wins: a second one is refused so a
 * late approval cannot overturn a refusal the user already made.
 */
export async function recordSyncDecision(stateRoot: string, decision: import('@linmu/dsh-session-contracts').InstanceSyncDecisionResponse): Promise<{ readonly recorded: true } | { readonly recorded: false; readonly reason: string }> {
  const stored = await readSyncRequest(stateRoot, decision.requestId);
  if (stored === undefined) return { recorded: false, reason: '同步请求不存在或无法读取。' };
  if (stored.request.instanceId !== decision.instanceId || stored.request.profileId !== decision.profileId)
    return { recorded: false, reason: '同步决定属于另一个实例，已拒绝。' };
  if (stored.decision !== null) return { recorded: false, reason: '该同步请求已有决定，不再改动。' };
  const path = syncRequestPath(stateRoot, decision.requestId);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ request: stored.request, decision } satisfies StoredSyncRequest)}\n`, 'utf8');
  await rename(temporary, path);
  return { recorded: true };
}
