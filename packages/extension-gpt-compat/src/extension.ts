import { createHash } from "node:crypto";
import { gptExtensionSummarySchema, type ExtensionDataAdapter, type CanonicalEventV1, type GptExtensionSummary } from "@linmu/dsh-session-contracts";
import { PLUGIN_EVENTS, validatePluginEvent } from "./codec.js";
import { NAMESPACE, PLUGIN_VERSIONS } from "./manifest.js";

export const gptCompatExtensionAdapter: ExtensionDataAdapter = {
  namespace: NAMESPACE, label: "GPT 兼容插件", panelAdapter: { id: NAMESPACE, label: "GPT 兼容插件" },
  pluginVersions: PLUGIN_VERSIONS, schemaVersions: [1],
  capabilities: { read: true, write: false, delete: false, restore: false, panel: true, context: false },
  nativeEvents: { hostAdapterId: "dsh-0.1.5", types: PLUGIN_EVENTS,
    validate(event) { validatePluginEvent(event as Parameters<typeof validatePluginEvent>[0]); } },
  validate(content) { gptExtensionSummarySchema.parse(content.body); },
  ownership(content) { const state = gptExtensionSummarySchema.parse(content.body);
    return { ownerSessionId: state.ownerSessionId, kind: state.kind, readOnly: true }; },
  summarize(body) { const s = gptExtensionSummarySchema.parse(body);
    return `${s.checkpoints} 个检查点 · ${s.nativeCompactions} 次原生压缩 · ${s.portableSummaries} 次本地摘要 · ${s.projections} 次请求投影`; },
  preview(body) { const s = gptExtensionSummarySchema.parse(body); return { kind: "rows", total: 7, rows: [
    { label: "检查点 / 已提交", text: `${s.checkpoints} / ${s.commits}` },
    { label: "原生压缩", text: String(s.nativeCompactions) },
    { label: "本地摘要", text: String(s.portableSummaries) },
    { label: "操作结果", text: String(s.results) },
    { label: "请求投影", text: String(s.projections) },
    { label: "来源版本", text: s.sourceVersion },
    { label: "保存方式", text: "原始扩展事件随会话保存；此处是只读索引，不展开加密内容。" },
  ] }; },
};

export function summarizeSessionEvents(ownerSessionId: string, sourceVersion: string, events: readonly CanonicalEventV1[]): GptExtensionSummary | null {
  const owned = events.filter(e => e.source.platform === "dsh" && e.extensions.nativeFormatVersion === 3 &&
    ["dsh-0.1.5", "dsh-gpt-compat"].includes(String(e.extensions.adapterId)) && PLUGIN_EVENTS.has(String(e.extensions.dshEventType)));
  if (!owned.length) return null;
  let checkpoints = 0, commits = 0, nativeCompactions = 0, portableSummaries = 0, results = 0, projections = 0;
  const digest = createHash("sha256");
  for (const event of owned) {
    const raw = event.rawPayload as unknown as Parameters<typeof validatePluginEvent>[0];
    if (!raw || raw.type !== event.extensions.dshEventType || String(raw.seq) !== event.source.eventId) throw new TypeError("GPT extension source identity differs");
    validatePluginEvent(raw); digest.update(JSON.stringify(raw));
    if (raw.type === "context/checkpoint") checkpoints++;
    if (raw.type === "context/checkpoint-commit") commits++;
    if (raw.type === "context/operation-result") results++;
    if (raw.type === "request/projection") projections++;
    if (raw.type === "context/operation") {
      if ((raw.data as {kind: string}).kind === "native-compact") nativeCompactions++; else portableSummaries++;
    }
  }
  return { kind: "gpt-session-state", ownerSessionId, sourceVersion, sourceDigest: digest.digest("hex"), eventCount: owned.length,
    checkpoints, commits, nativeCompactions, portableSummaries, results, projections,
    lastEventSeq: Math.max(...owned.map(e => Number(e.source.eventId))) };
}
