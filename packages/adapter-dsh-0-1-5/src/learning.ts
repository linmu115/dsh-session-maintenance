import type { CanonicalProjectionSessionInput, JsonValue, ProjectionRun, LearningMessage, NativeAppendOperation } from "@linmu/dsh-session-contracts";
import { LEARNING_SKIPPED_IMAGE_TEXT, ExtensionDataError } from "@linmu/dsh-session-contracts";
import type { SessionFormatArtifact, SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import { materializeV3 } from "./materialize.js";
import { normalizeV3Append } from "./normalize-append.js";
import { record, isRecord, digest } from "./common.js";
import { validateV3, visibleContext } from "./official.js";

function textContent(value: JsonValue, images: { count: number }, allowToolCalls = false): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("学习消息正文格式不受支持");
  return value.flatMap(block => {
    const b = record(block);
    if (b.type === "image") { images.count++; return []; }
    if (allowToolCalls && b.type === "tool-call") return [];
    if (!["text", "input_text", "output_text"].includes(String(b.type)) || typeof b.text !== "string")
      throw new ExtensionDataError("LEARNING_UNSUPPORTED_CONTENT", "学习消息包含尚不支持的非文本材料；当前仅跳过图片", 409);
    return [b.text];
  }).join("\n");
}
/** Read exactly the native messages that DSH folds; keep native envelopes inside the adapter. */
export async function prepareLearningV3(item: CanonicalProjectionSessionInput, run: ProjectionRun) {
  let payload: Record<string, JsonValue> | undefined, nativeSessionId = "";
  await materializeV3({ run, sessions: [item], workspaces: [] }, {
    writeWorkspace: async () => {}, writeSession: async (id, value) => { nativeSessionId = id; payload = record(value); },
  });
  if (!payload) throw new Error("缺少 DSH 学习投影");
  const source = payload;
  const artifact = { header: source.header, events: source.events, inheritedEventCount: source.inheritedEventCount } as unknown as SessionFormatArtifact;
  const folded = visibleContext(artifact) as { messages?: unknown[] } | unknown[];
  // Projection histories containing rewrites need the existing reader's semantic handling.
  if (artifact.events.some(e => e.surfaceOp && e.surfaceOp !== "append")) throw new Error("学习历史存在上下文替换，需先核对有效消息后再绑定");
  void folded;
  return { messages: learningMessagesFromV3(artifact), nativeSessionId, artifact, source };
}

export function learningMessagesFromV3(artifact: SessionFormatArtifact): LearningMessage[] {
  const messages: LearningMessage[] = [];
  for (const e of artifact.events) {
    const d = record(e.data);
    if (e.type === "user/message" || e.type === "assistant/message") {
      const m = e.type === "user/message" ? d : record(d.message);
      const images = { count: 0 }, body = textContent(m.content ?? [], images, e.type === "assistant/message");
      const text = !body.trim() && images.count ? LEARNING_SKIPPED_IMAGE_TEXT : body;
      if (text.trim()) messages.push({ id: String(m.id), role: e.type === "user/message" ? "user" : "assistant", text,
        startedAt: null, completedAt: null, ...(images.count ? { skippedImages: images.count } : {}) });
    } else if (e.type === "tool/result") {
      const meta = isRecord(d.presentationMeta) ? d.presentationMeta : isRecord(d.meta) ? d.meta : {};
      if (isRecord(meta.nativeContext)) {
        const message = record(d.message), content = message.content;
        if (!Array.isArray(content)) throw new Error("引用上下文无法解析");
        const images = { count: 0 }, body = content.map(block => textContent(record(block).content ?? [], images)).join("\n");
        const text = !body.trim() && images.count ? LEARNING_SKIPPED_IMAGE_TEXT : body;
        messages.push({ id: `context-${e.seq}`, role: "user", text: `[引用上下文快照]\n${text}`, startedAt: null, completedAt: null,
          ...(images.count ? { skippedImages: images.count } : {}) });
      }
    }
  }
  return messages;
}

export async function appendLearningV3(item: CanonicalProjectionSessionInput, run: ProjectionRun, messages: readonly LearningMessage[], operationId: string, at: string) {
  const { artifact, source, nativeSessionId } = await prepareLearningV3(item, run);
  const tail: SessionFormatEvent[] = [];
  let turn = Math.max(0, ...artifact.events.map(e => Number(record(e.data).turn) || 0));
  let open = false;
  const emit = (type: string, data: JsonValue, surface = false) => tail.push({ type, data, seq: artifact.events.length + tail.length,
    time: Date.parse(at), ...(surface ? { surfaceOp: "append" as const } : {}) });
  for (const m of messages) {
    const id = `learning:${digest([operationId, m.id]).slice(7)}`;
    if (m.role === "user") {
      if (open) throw new Error("Codex 问答顺序不完整");
      turn++; open = true; emit("turn/start", { turn }); emit("step/start", { turn, step: 1 });
      emit("user/message", { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text: m.text }] }, true);
    } else {
      if (!open) throw new Error("Codex 回答缺少本次问题");
      emit("assistant/message", { turn, step: 1, message: { id, role: "assistant", source: { kind: "model", provider: "codex", model: "imported" },
        content: [{ type: "text", text: m.text }] }, stream: [] }, true);
      emit("step/end", { turn, step: 1 }); emit("turn/end", { turn, reason: { kind: "completed" } }); open = false;
    }
  }
  if (open) throw new Error("Codex 回答尚未完成");
  const combined = validateV3({ ...artifact, events: [...artifact.events, ...tail] }); visibleContext(combined);
  const operation: NativeAppendOperation = { runId: run.id, operationId: operationId as never,
    nativeSessionId: nativeSessionId as never, nativeRevision: combined.events.length, observedAt: at,
    payload: { ...source, events: tail as unknown as JsonValue, instanceId: run.instanceId } };
  const normalized = await normalizeV3Append(operation);
  const origin = new Map(messages.map(m => [`learning:${digest([operationId, m.id]).slice(7)}`, m.id]));
  return normalized.events.map(e => {
    const data = record(e.content), message = e.kind === "assistant-message" ? record(data.message) : data;
    return { ...e, extensions: { ...e.extensions, learningImportOperationId: operationId,
      ...(typeof message.id === "string" && origin.has(message.id) ? { learningCodexMessageId: origin.get(message.id)! } : {}) } };
  });
}
