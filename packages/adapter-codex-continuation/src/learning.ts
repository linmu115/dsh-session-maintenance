import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { CodexContinuationTarget, LearningCodexPort, LearningCursor, LearningMessage, LearningSnapshot } from "@linmu/dsh-session-contracts";
import { LEARNING_SKIPPED_IMAGE_TEXT, ExtensionDataError } from "@linmu/dsh-session-contracts";
import { StdioAppServerTransport } from "./transport.js";
import type { AppServerTransportFactory, AppServerTransport } from "./types.js";

const digest = (rows: readonly string[]) => createHash("sha256").update(rows.join("\n")).digest("hex");
const fail = (message: string): never => { throw new Error(`学习交接：${message}`); };
type Row = { timestamp?: string; type?: string; payload?: Record<string, any> };
/** Public conversational records only; hidden reasoning never crosses the port. */
export function parseLearningLog(text: string, after?: LearningCursor): LearningSnapshot {
  if (!text.endsWith("\n")) return fail("Codex 日志仍在写入，请稍后重试");
  const lines = text.trimEnd().split("\n");
  if (after && (lines.length < after.count || digest(lines.slice(0, after.count)) !== after.digest)) return fail("Codex 已有历史发生变化，禁止追加");
  const rows = lines.map(line => JSON.parse(line) as Row);
  const starts = new Map<string, string>(), ends = new Map<string, string>();
  let current: string | undefined, busy = false;
  for (const row of rows) {
    const p = row.payload ?? {};
    if (row.type !== "event_msg") continue;
    if (p.type === "task_started") { current = p.turn_id; starts.set(current!, row.timestamp!); busy = true; }
    if (p.type === "task_complete" || p.type === "task_completed" || p.type === "turn_aborted") {
      ends.set(p.turn_id ?? current, row.timestamp!); busy = false;
    }
  }
  const messages: LearningMessage[] = [];
  current = undefined;
  for (const [index, row] of rows.entries()) {
    const p = row.payload ?? {};
    if (row.type === "event_msg" && p.type === "task_started") current = p.turn_id;
    if (index < (after?.count ?? 0)) continue;
    if (after && (row.type === "compacted" || p.type === "thread_rolled_back" || p.type === "turn_aborted")) return fail("Codex 历史经过压缩、回滚或中断，需重新核对边界");
    if (row.type !== "response_item") continue;
    if (after && !["message", "reasoning"].includes(String(p.type))) return fail("新增内容含工具执行，当前仅支持纯学习问答");
    if (p.type !== "message" || !["user", "assistant"].includes(p.role) || ["analysis", "commentary"].includes(p.channel) || p.phase === "commentary") continue;
    if (!Array.isArray(p.content)) return fail("消息正文格式不受支持");
    let skippedImages = 0;
    let body = p.content.flatMap((c: any) => {
      if (c?.type === "input_image" || c?.type === "output_image") { skippedImages++; return []; }
      if (!["input_text", "output_text"].includes(c?.type) || typeof c?.text !== "string")
        throw new ExtensionDataError("LEARNING_UNSUPPORTED_CONTENT", "Codex 消息包含尚不支持的非文本材料；当前仅跳过图片", 409);
      return [c.text];
    }).join("\n");
    // Match the Codex read adapter's public text boundary; these are host envelopes,
    // not learner turns. Retain the actual request in a mixed envelope/message.
    if (p.role === "user") {
      const originalBody = body;
      for (const tag of ["codex_internal_context", "in-app-browser-context", "environment_context", "recommended_plugins", "system-reminder", "app-context"]) {
        body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "giu"), "");
      }
      body = body.replace(/^(?:\s*&#x0*20;)+/iu, "");
      if (body !== originalBody) body = body.trim();
    }
    if (!body.trim() && skippedImages) body = LEARNING_SKIPPED_IMAGE_TEXT;
    if (!body.trim()) continue;
    const turn = p.internal_chat_message_metadata_passthrough?.turn_id ?? current;
    messages.push({ id: p.id ?? `row-${index}`, role: p.role, text: body,
      startedAt: starts.get(turn) ?? null, completedAt: ends.get(turn) ?? null, ...(skippedImages ? { skippedImages } : {}) });
  }
  return { cursor: { count: lines.length, digest: digest(lines) }, messages, busy, name: "" };
}

export class CodexLearningAdapter implements LearningCodexPort {
  constructor(private readonly factory: AppServerTransportFactory = target => new StdioAppServerTransport(target)) {}
  private async using<T>(target: CodexContinuationTarget, action: (transport: AppServerTransport) => Promise<T>): Promise<T> {
    const t = this.factory(target);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = async () => {
        if (await t.version() !== "0.153.4") return fail("当前仅验证 Codex CLI 0.153.4，请先核验适配版本");
        await t.request("initialize", { clientInfo: { name: "maintenance-learning", version: "1" }, capabilities: { experimentalApi: true } });
        await t.notify("initialized");
        return action(t);
      };
      return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex 交接超时，结果需要核验")), 30_000); })]);
    } finally { if (timer) clearTimeout(timer); await t.close(); }
  }
  private async readWith(t: AppServerTransport, target: CodexContinuationTarget, threadId: string, after?: LearningCursor) {
    const { thread } = await t.request<{ thread: { id: string; path: string; name?: string; historyMode: string; status: { type: string } } }>("thread/read", { threadId, includeTurns: false });
    if (thread.id !== threadId || !["legacy", "paginated"].includes(thread.historyMode)) return fail("此 Codex 历史格式尚未通过学习交接验证");
    if (!target.codexHome || !thread.path) return fail("Codex 来源位置不可核验");
    const root = await realpath(target.codexHome), path = await realpath(thread.path), child = relative(root, path);
    if (!child || child.startsWith("..") || isAbsolute(child)) return fail("任务日志不在已登记的 Codex 来源中");
    if ((await stat(path)).size > 32 * 1024 * 1024) return fail("学习历史超过首版读取上限");
    const bytes = await readFile(path, "utf8"), second = await readFile(path, "utf8");
    if (bytes !== second) return fail("Codex 正在写入，请待回答完成后重试");
    const state = parseLearningLog(bytes, after);
    return { ...state, name: thread.name ?? threadId, busy: state.busy || thread.status.type === "active" };
  }
  read(target: CodexContinuationTarget, threadId: string, after?: LearningCursor) {
    return this.using(target, t => this.readWith(t, target, threadId, after));
  }
  inject(target: CodexContinuationTarget, threadId: string, before: LearningCursor, operationId: string, messages: readonly LearningMessage[]) {
    return this.using(target, async t => {
      const initial = await this.readWith(t, target, threadId);
      if (initial.busy || JSON.stringify(initial.cursor) !== JSON.stringify(before)) return fail("Codex 在同步前已变化");
      await t.request("thread/resume", { threadId, excludeTurns: true });
      const resumed = await this.readWith(t, target, threadId, before);
      if (resumed.busy || resumed.messages.length) return fail("Codex 在加载过程中有新问答");
      const marker = `[maintenance-learning:${operationId}] Imported learning history follows. Preserve its user/assistant roles as historical context; do not answer it again.`;
      await t.request("thread/inject_items", { threadId, items: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: marker }] },
        ...messages.map(message => ({ type: "message", role: message.role,
          content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.text }] })),
      ] });
      // An RPC acknowledgement can precede the writer flush. Never retry injection here.
      for (let attempt = 0; attempt < 20; attempt++) {
        const delta = await this.readWith(t, target, threadId, resumed.cursor);
        if (delta.busy) return fail("注入期间 Codex 开始生成；交接状态需要核验");
        if (delta.messages.length === messages.length && delta.messages.every((m, i) => m.role === messages[i]!.role && m.text === messages[i]!.text)) return delta;
        if (delta.messages.length > messages.length) return fail("注入期间出现额外问答");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return fail("未确认注入落盘，请核验本次交接，禁止盲目重试");
    });
  }
}
