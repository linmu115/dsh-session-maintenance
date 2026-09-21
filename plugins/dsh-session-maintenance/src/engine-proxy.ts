import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";

import type { Config } from "./config.js";
import { identityDeclaration } from "./instance-identity.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type ProxyOperation =
  | "identity"
  | "status"
  | "reference:resolve"
  | "resolve"
  | "scan-current"
  | "sync-current"
  | "dashboard"
  | "compare"
  | "graph"
  | "checkpoint"
  | "unlink-candidate"
  | "archive-candidate"
  | "delete-candidate"
  | "delete-session"
  | "settings:get"
  | "settings:patch"
  | "join-workspace";

export interface ProxyRequest {
  readonly operation: ProxyOperation;
  readonly instanceId?: string;
  readonly sessionId?: string;
  readonly applySafe?: boolean;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly referenceType?: "annotation" | "sticker" | "obsidian-reference";
  readonly logicalSessionId?: string | null;
  readonly logicalAnchorId?: string | null;
  readonly legacyNativeSessionId?: string | null;
  readonly legacyNativeAnchorId?: string | null;
  /** The workspace-level entry: which workspace, and where its sessions live. */
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly workspacePath?: string;
}

export interface ProxyResult {
  readonly ok: true;
  readonly message: string;
  /** Machine-readable outcome for callers that must distinguish an idempotent repeat. */
  readonly code?: "joined" | "already-joined";
  /**
   * The declared identity, answered by the `identity` operation.
   *
   * The browser half needs its own instance id and profile id to key a deferred
   * workspace join; they live in the host's configuration, so the host states them
   * here instead of the client guessing.
   */
  readonly identity?: {
    readonly apiVersion: 1;
    readonly instanceId: string;
    readonly profileId: string;
    readonly declared: boolean;
  };
  readonly logicalSessionId?: string;
  readonly planId?: string;
  readonly jobId?: string;
  readonly url?: string;
  readonly deletion?: { readonly logicalSessionId: string; readonly state: "deleted" | "pending-delete"; readonly pendingOperations: number };
  readonly settings?: unknown;
  readonly referenceResolution?: {
    readonly referenceType: "annotation" | "sticker" | "obsidian-reference";
    readonly logicalSessionId: string | null;
    readonly logicalAnchorId: string | null;
    readonly nativeSessionId: string | null;
    readonly nativeAnchorId: string | null;
    readonly runId: string | null;
    readonly status: "resolved" | "unavailable";
  };
}

/** Why a requested maintenance operation could not be carried out. */
export type ProxyErrorCode = "engine-unreachable" | "engine-error" | "invalid-input";

/**
 * A failure the caller can act on, carried across the client boundary.
 *
 * The browser half has to tell "the Engine is not running" from "the Engine
 * refused", because only the first one is a deferred join rather than a failure;
 * a message alone would force it to match on prose.
 */
export class ProxyError extends Error {
  constructor(readonly code: ProxyErrorCode, message: string) { super(message); this.name = "ProxyError"; }
}

/** A workspace join as the Engine reports it: what it mapped now and what was already there. */
export interface WorkspaceJoinReceipt {
  readonly workspaceId: string;
  readonly mapped: readonly unknown[];
  readonly alreadyPresent: readonly unknown[];
  readonly failures: readonly unknown[];
}

/** `already-joined` is the idempotent repeat: the mapping existed and nothing new was written. */
export function workspaceJoinCode(receipt: WorkspaceJoinReceipt): "joined" | "already-joined" {
  return receipt.mapped.length === 0 && receipt.alreadyPresent.length > 0 ? "already-joined" : "joined";
}

export interface EngineConnection {
  readonly origin: string;
  readonly token: string;
}

export interface EngineConnectionProvider {
  current(): Promise<EngineConnection>;
}

export class FileConnectionProvider implements EngineConnectionProvider {
  private cached: { readonly mtimeMs: number; readonly value: EngineConnection } | undefined;

  constructor(private readonly descriptorPath: string) {}

  async current(): Promise<EngineConnection> {
    let details;
    try { details = await stat(this.descriptorPath); } catch { throw new Error("维护引擎连接描述符不可用；请运行可信安装器登记 Engine"); }
    if (this.cached?.mtimeMs === details.mtimeMs) return this.cached.value;
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.descriptorPath, "utf8")); } catch { throw new Error("维护引擎连接描述符无法读取"); }
    if (typeof parsed !== "object" || parsed === null) throw new Error("维护引擎连接描述符格式无效");
    const value = parsed as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.host !== "127.0.0.1" || !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) {
      throw new Error("维护引擎连接描述符不是受支持的 loopback v1 格式");
    }
    if (typeof value.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(value.token)) throw new Error("维护引擎连接描述符缺少有效 capability");
    const connection = { origin: `http://127.0.0.1:${value.port as number}`, token: value.token };
    this.cached = { mtimeMs: details.mtimeMs, value: connection };
    return connection;
  }
}

interface Resolution {
  readonly logicalSessionId: string;
  readonly title: string;
  readonly status: string;
}

interface SessionDetail {
  readonly bindings: ReadonlyArray<{
    readonly id: string;
    readonly key: { readonly platform: "codex" | "dsh"; readonly instanceId: string; readonly sessionId: string };
  }>;
}

function safeId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new TypeError(`${name} 必须是已登记 ID，不能是路径`);
  return value;
}

/** Free text the user's own workspace supplied; it is never used as a path. */
function safeText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1_000) throw new TypeError(`${name} 无效`);
  return value.trim();
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new TypeError("请求内容过大");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function assertRequest(value: unknown): ProxyRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("请求必须是对象");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "operation", "instanceId", "sessionId", "applySafe", "settings", "referenceType",
    "logicalSessionId", "logicalAnchorId", "legacyNativeSessionId", "legacyNativeAnchorId",
    // The workspace-level entry: which workspace it is, and where its sessions live.
    "workspaceId", "workspaceName", "workspacePath",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new TypeError("请求包含未允许字段");
  const operations: readonly ProxyOperation[] = [
    "identity", "status", "reference:resolve", "resolve", "scan-current", "sync-current", "dashboard", "compare", "graph", "checkpoint",
    "unlink-candidate", "archive-candidate", "delete-candidate", "delete-session", "settings:get", "settings:patch", "join-workspace",
  ];
  if (!operations.includes(record.operation as ProxyOperation)) throw new TypeError("未知维护操作");
  if (record.operation === "delete-session" && Object.keys(record).some(key => key !== "operation" && key !== "sessionId")) {
    throw new TypeError("删除只接受当前实例的原生会话 ID，不能指定其他实例或真源 ID");
  }
  // The workspace entry is the only operation that carries a workspace directory, and that
  // directory is resolved by the Engine against its own records — never used as a path here.
  if (record.operation === "join-workspace") {
    const extras = Object.keys(record).filter(key => !["operation", "instanceId", "workspaceId", "workspaceName", "workspacePath"].includes(key));
    if (extras.length > 0) throw new TypeError("工作区加入只接受工作区标识、名称与目录");
    safeId(record.workspaceId, "workspaceId");
    safeText(record.workspaceName, "workspaceName");
    safeText(record.workspacePath, "workspacePath");
  }
  if (record.instanceId !== undefined) safeId(record.instanceId, "instanceId");
  if (record.sessionId !== undefined) safeId(record.sessionId, "sessionId");
    if (record.applySafe !== undefined && typeof record.applySafe !== "boolean") throw new TypeError("applySafe 必须是布尔值");
  if (record.operation === "reference:resolve") {
    if (!["annotation", "sticker", "obsidian-reference"].includes(String(record.referenceType))) {
      throw new TypeError("referenceType 不是受支持的引用类型");
    }
    for (const key of ["logicalSessionId", "logicalAnchorId", "legacyNativeSessionId", "legacyNativeAnchorId"] as const) {
      const value = record[key];
      if (value !== undefined && value !== null) safeId(value, key);
    }
    if (record.logicalSessionId == null && record.legacyNativeSessionId == null) {
      throw new TypeError("引用必须包含逻辑会话或旧原生会话 ID");
    }
  }
  return record as unknown as ProxyRequest;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "维护引擎请求失败";
  return error.message.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]").slice(0, 300);
}

export class RestrictedEngineProxy {
  readonly defaultInstanceId: string;
  private readonly connection: EngineConnectionProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly pending = new Map<string, Promise<ProxyResult>>();

  constructor(private readonly config: Config, connection: EngineConnectionProvider, fetchImpl: typeof fetch = fetch,
    private readonly projectionRunId?: string) {
    this.connection = connection;
    this.defaultInstanceId = config.dshInstanceId;
    this.fetchImpl = fetchImpl;
  }

  async invoke(input: ProxyRequest): Promise<ProxyResult> {
    const request = assertRequest(input);
    const key = JSON.stringify(request);
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    const running = this.execute(request).finally(() => this.pending.delete(key));
    this.pending.set(key, running);
    return running;
  }

  private async execute(input: ProxyRequest): Promise<ProxyResult> {
    if (input.operation === "identity") {
      // The browser half reads this once and keys its workspace joins with it. An undeclared
      // identity is a normal state — the instance still runs — so it is reported, not thrown.
      const identity = identityDeclaration(this.config.dshInstanceId, this.config.profileId);
      return identity.declared
        ? { ok: true, message: "已读取本机实例身份", identity: { apiVersion: 1, instanceId: identity.instanceId, profileId: identity.profileId ?? "", declared: true } }
        : { ok: true, message: "本机未声明实例身份", identity: { apiVersion: 1, instanceId: identity.instanceId, profileId: identity.profileId ?? "", declared: false } };
    }
    if (input.operation === "status") {
      await this.engine("/v1/health");
      return { ok: true, message: "维护引擎在线" };
    }
    if (input.operation === "reference:resolve") {
      const value = await this.engine("/v1/references/resolve", "POST", {
        targetInstanceId: this.config.dshInstanceId,
        targetProfileId: this.config.profileId,
        referenceType: input.referenceType,
        logicalSessionId: input.logicalSessionId ?? null,
        logicalAnchorId: input.logicalAnchorId ?? null,
        legacyNativeSessionId: input.legacyNativeSessionId ?? null,
        legacyNativeAnchorId: input.legacyNativeAnchorId ?? null,
      }) as { referenceResolution?: never; resolution: NonNullable<ProxyResult["referenceResolution"]> };
      return { ok: true, message: "已解析稳定引用", referenceResolution: value.resolution };
    }
    if (input.operation === "settings:get") {
      const value = await this.engine("/v1/settings");
      return { ok: true, message: "已读取维护参数", settings: (value as { settings?: unknown }).settings };
    }
    if (input.operation === "settings:patch") {
      const settings = this.safeSettings(input.settings);
      const value = await this.engine("/v1/settings", "PATCH", settings);
      return { ok: true, message: "维护参数已保存", settings: (value as { settings?: unknown }).settings };
    }

    const instanceId = safeId(input.instanceId ?? this.defaultInstanceId, "instanceId");
    if (input.operation === "join-workspace") {
      // The Engine maps the workspace's own directory: it is the side that can
      // read the instance's sessions and write them into Maintenance's storage.
      const workspaceId = safeId(input.workspaceId, "workspaceId");
      const workspaceName = safeText(input.workspaceName, "workspaceName");
      const workspacePath = safeText(input.workspacePath, "workspacePath");
      const value = await this.engine("/v1/instances/workspace-joins", "POST", { instanceId, profileId: this.config.profileId,
        workspaceId, workspaceName, workspacePath }) as { join?: WorkspaceJoinReceipt };
      const join = value.join;
      if (join === undefined || typeof join.workspaceId !== "string" || !Array.isArray(join.mapped)
        || !Array.isArray(join.alreadyPresent) || !Array.isArray(join.failures)) {
        throw new ProxyError("engine-error", "维护引擎未返回匹配的工作区加入回执；请检查状态后重试");
      }
      const skipped = join.failures.length === 0 ? "" : `；${join.failures.length} 个会话未能读取`;
      const code = workspaceJoinCode(join);
      return { ok: true, code, message: code === "already-joined"
        ? `「${workspaceName}」已在维护范围内：${join.alreadyPresent.length} 个会话已映射${skipped}`
        : `已把「${workspaceName}」加入维护范围：映射 ${join.mapped.length} 个会话，已有 ${join.alreadyPresent.length} 个${skipped}` };
    }
    if (input.operation === "scan-current") {
      const value = await this.engine("/v1/jobs/scan", "POST", { instanceIds: [instanceId] }) as { job: { id: string } };
      return { ok: true, message: "已提交当前 DSH 实例扫描；Engine 会按稳定 ID 更新此会话", jobId: value.job.id };
    }
    if (input.operation === "dashboard" && input.sessionId === undefined) {
      const value = await this.engine("/v1/ui/launch-code", "POST", {}) as { launch: { url: string } };
      return { ok: true, message: "已打开会话维护看板", url: value.launch.url };
    }
    const sessionId = safeId(input.sessionId, "sessionId");
    if (input.operation === "delete-session") {
      // Active projection deletion resolves and tombstones in one Engine call.
      const legacy = this.projectionRunId === undefined ? await this.resolve(instanceId, sessionId) : undefined;
      const value = await this.engine(this.projectionRunId === undefined
        ? `/v1/canonical/sessions/${encodeURIComponent(legacy!.logicalSessionId)}`
        : `/v1/projection-runs/${encodeURIComponent(this.projectionRunId)}/sessions/${encodeURIComponent(sessionId)}`,
      "DELETE") as { resolution?: Resolution; deletion?: NonNullable<ProxyResult["deletion"]> };
      const resolution = legacy ?? value.resolution;
      const deletion = value.deletion;
      if (resolution === undefined || deletion === undefined || deletion.logicalSessionId !== resolution.logicalSessionId
        || !["deleted", "pending-delete"].includes(deletion.state)
        || !Number.isSafeInteger(deletion.pendingOperations) || deletion.pendingOperations < 0) throw new Error("Maintenance 未返回匹配的真源删除回执；请检查状态后重试");
      return { ok: true, logicalSessionId: resolution.logicalSessionId, deletion,
        message: deletion.state === "deleted" ? "Maintenance 真源已删除；Codex 原始会话未修改"
          : "Maintenance 已登记删除，待现有写入收尾；Codex 原始会话未修改" };
    }
    const resolution = await this.resolve(instanceId, sessionId);
    if (input.operation === "resolve") return { ok: true, message: "已定位逻辑会话", logicalSessionId: resolution.logicalSessionId };

    if (["dashboard", "compare", "graph", "unlink-candidate", "archive-candidate", "delete-candidate"].includes(input.operation)) {
      const value = await this.engine("/v1/ui/launch-code", "POST", { logicalSessionId: resolution.logicalSessionId }) as { launch: { url: string } };
      const label: Record<string, string> = {
        dashboard: "已打开会话维护看板",
        compare: "已打开三方差异与版本工作台",
        graph: "已打开会话版本图",
        "unlink-candidate": "已打开解除映射候选；不会直接改写平台会话",
        "archive-candidate": "已打开归档计划预览；不会从菜单直接写入平台",
        "delete-candidate": "已打开删除候选说明；阶段二不会执行平台删除",
      };
      return { ok: true, message: label[input.operation]!, logicalSessionId: resolution.logicalSessionId, url: value.launch.url };
    }

    if (input.operation === "checkpoint") {
      const graph = await this.engine(`/v1/sessions/${encodeURIComponent(resolution.logicalSessionId)}/graph`) as {
        graph: { refs: ReadonlyArray<{ name: string; versionId: string }>; nodes: ReadonlyArray<{ id: string }> };
      };
      const versionId = graph.graph.refs[0]?.versionId ?? graph.graph.nodes[0]?.id;
      if (versionId === undefined) throw new Error("当前会话没有可建立 Checkpoint 的版本");
      await this.engine("/v1/checkpoints", "POST", {
        name: `会话 ${resolution.title}`,
        description: "从 DSH 会话菜单建立的手动 Checkpoint",
        refs: { [resolution.logicalSessionId]: versionId },
        backupTransactionIds: [],
        createdBy: "dsh-session-maintenance",
        createdAt: new Date().toISOString(),
      });
      return { ok: true, message: "已建立 Checkpoint", logicalSessionId: resolution.logicalSessionId };
    }

    const detail = await this.engine(`/v1/sessions/${encodeURIComponent(resolution.logicalSessionId)}`) as { session: SessionDetail };
    const source = detail.session.bindings.find((binding) => binding.key.platform === "codex");
    const target = detail.session.bindings.find((binding) => binding.key.platform === "dsh" && binding.key.instanceId === instanceId && binding.key.sessionId === sessionId);
    if (source === undefined || target === undefined) throw new Error("当前会话尚未同时映射 Codex 与 DSH；请先扫描并在看板确认映射");
    const created = await this.engine("/v1/plans", "POST", {
      logicalSessionId: resolution.logicalSessionId,
      sourceBindingId: source.id,
      targetBindingId: target.id,
      createdAt: new Date().toISOString(),
    }) as { plan: { id: string; risk: string; confirmations: readonly unknown[] } };
    if (input.operation !== "sync-current" || input.applySafe !== true || created.plan.risk !== "safe" || created.plan.confirmations.length > 0) {
      return {
        ok: true,
        message: created.plan.risk === "safe" ? "已生成安全计划，等待你确认应用" : "计划需要人工复核，已保留到看板",
        logicalSessionId: resolution.logicalSessionId,
        planId: created.plan.id,
      };
    }
    const applied = await this.engine(`/v1/plans/${encodeURIComponent(created.plan.id)}/apply`, "POST", {}) as { job: { id: string } };
    return { ok: true, message: "安全计划已提交", logicalSessionId: resolution.logicalSessionId, planId: created.plan.id, jobId: applied.job.id };
  }

  private async resolve(instanceId: string, sessionId: string): Promise<Resolution> {
    if (this.projectionRunId !== undefined) {
      const value = await this.engine(`/v1/projection-runs/${encodeURIComponent(this.projectionRunId)}/sessions/${encodeURIComponent(sessionId)}/identity`) as { resolution: Resolution };
      return value.resolution;
    }
    const value = await this.engine("/v1/session-resolution", "POST", { platform: "dsh", instanceId, sessionId }) as { resolution: Resolution };
    return value.resolution;
  }

  private safeSettings(input: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
    if (input === undefined) throw new TypeError("缺少 settings");
    const allowed = new Set(["codexInstanceId", "dshInstanceId", "workspaceMappingId", "syncSingleSidedTitle", "syncArchive", "scanScope", "backupRetention", "allowBatchSafeApply"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("settings 包含未允许字段");
    for (const key of ["codexInstanceId", "dshInstanceId", "workspaceMappingId"]) {
      const value = input[key];
      if (value !== undefined && value !== null) safeId(value, key);
    }
    return input;
  }

  private async engine(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let connection: EngineConnection;
    try { connection = await this.connection.current(); }
    // No registered descriptor is the same answer as a stopped Engine: there is nothing to
    // hand the request to, and the caller may legitimately retry later.
    catch (error) { throw new ProxyError("engine-unreachable", error instanceof Error ? error.message : "维护引擎连接描述符不可用"); }
    let response: Response;
    try {
      response = await this.fetchImpl(`${connection.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${connection.token}`,
          origin: connection.origin,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ProxyError("engine-unreachable", "维护引擎离线；请先启动本机 Engine");
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new ProxyError("engine-error", "维护引擎响应超出限制");
    if (!response.ok) {
      let message = `维护引擎返回 HTTP ${response.status}`;
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* bounded status only */ }
      throw new ProxyError("engine-error", message.replaceAll(connection.token, "[REDACTED]"));
    }
    return JSON.parse(text) as unknown;
  }
}

export function createProxyHandler(proxy: RestrictedEngineProxy, endpoint = "/dsh-session-maintenance/api") {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== endpoint) { sendJson(response, 404, { ok: false, error: "接口不存在" }); return; }
    if (request.method !== "POST") { response.setHeader("allow", "POST"); sendJson(response, 405, { ok: false, error: "只允许 POST" }); return; }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      sendJson(response, 415, { ok: false, error: "只允许 application/json 请求" }); return;
    }
    if (request.headers.origin !== undefined) {
      let sameOrigin = false;
      try {
        const origin = new URL(request.headers.origin);
        sameOrigin = ["http:", "https:"].includes(origin.protocol) && origin.host === request.headers.host;
      } catch { /* Opaque or malformed browser origins cannot mutate canonical state. */ }
      if (!sameOrigin) { sendJson(response, 403, { ok: false, error: "只允许 DSH 同源页面调用" }); return; }
    }
    if (request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin") {
      sendJson(response, 403, { ok: false, error: "只允许 DSH 同源页面调用" });
      return;
    }
    try {
      const result = await proxy.invoke(assertRequest(await readJson(request)));
      sendJson(response, 200, result);
    } catch (error) {
      // The code travels with the failure so the browser half can tell a stopped Engine from a
      // refused request without matching on the message.
      const code: ProxyErrorCode = error instanceof ProxyError ? error.code
        : error instanceof TypeError ? "invalid-input" : "engine-error";
      sendJson(response, 400, { ok: false, code, error: errorMessage(error) });
    }
  };
}
