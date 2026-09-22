import { createHash } from "node:crypto";
import {
  ANNOTATION_RECORDS_NAMESPACE, annotationMirrorSyncSchema, annotationMirrorRecordSchema, ExtensionDataError,
  type AnnotationMirrorSync, type AnnotationMirrorSyncResult, type AnnotationMirrorReceipt, type AnnotationMirrorRecord,
  type ExtensionScope, type JsonValue, type RunId,
} from "@linmu/dsh-session-contracts";
import type { SqliteExtensionRepository } from "@linmu/dsh-session-store";
import type { SessionMaintenanceEngine } from "../../engine.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Positive, revision-fenced metadata mirror. Core remains the submission/outbox authority. */
export async function synchronizeAnnotationMirrors(store: SqliteExtensionRepository, engine: SessionMaintenanceEngine,
  input: AnnotationMirrorSync, requireWriter: (scope: ExtensionScope) => string): Promise<AnnotationMirrorSyncResult> {
  const q = annotationMirrorSyncSchema.parse(input);
  const run = await engine.projectionRunRepository.getProjectionRun(q.runId as RunId);
  if (!run || run.state !== "running") throw new ExtensionDataError("ANNOTATION_SYNC_RETRY", "目标实例的会话映射尚未就绪，请稍后重试。", 409);
  const scope = { instanceId: run.instanceId, profileId: run.profileId, namespace: ANNOTATION_RECORDS_NAMESPACE };
  const writerId = requireWriter(scope);
  if (writerId !== "dsh-annotation-core") throw new ExtensionDataError("EXTENSION_WRITER_CONFLICT", "引用镜像只能由 Annotation Core 同步。", 409);
  const initialTarget = await engine.sessionGraph.resolve(q.runId, { nativeSessionId: q.nativeSessionId }, true);
  const items: AnnotationMirrorReceipt[] = [];
  for (const entry of q.entries) {
    let target = initialTarget;
    if (entry.targetMessageId) {
      const verified = await engine.resolveStableReference({ referenceType: "obsidian-reference",
        targetInstanceId: run.instanceId, targetProfileId: run.profileId,
        logicalSessionId: target.logicalSessionId as never, logicalAnchorId: entry.targetMessageId,
        legacyNativeSessionId: q.nativeSessionId as never, legacyNativeAnchorId: entry.targetMessageId });
      if (verified.status !== "resolved" || !verified.logicalSessionId) {
        items.push({ referenceId: entry.referenceId, objectId: "unresolved", revision: 0, sourceRevision: q.sourceRevision,
          status: "deferred", reason: "Submitted reference target message is not yet verified" });
        continue;
      }
      target = { ...target, logicalSessionId: verified.logicalSessionId };
    }
    const objectId = `reference-${createHash("sha256").update(JSON.stringify([scope, target.logicalSessionId, entry.referenceId])).digest("hex")}`;
    const current = store.get(scope, objectId);
    const old = current ? annotationMirrorRecordSchema.parse(current.content.body) : undefined;
    const receipt = (status: AnnotationMirrorReceipt["status"], reason?: string): AnnotationMirrorReceipt => ({ referenceId: entry.referenceId,
      objectId, revision: current?.revision ?? 0, sourceRevision: old?.sourceRevision ?? q.sourceRevision, status, ...(reason ? { reason } : {}) });

    let source: AnnotationMirrorRecord["source"] = { ...entry.source };
    if (entry.state === "deleted" && old) source = { ...old.source, ...source };
    if (source.nativeSessionId && !(entry.state === "deleted" && old?.source.logicalSessionId)) {
      try { source.logicalSessionId = (await engine.sessionGraph.resolve(q.runId, { nativeSessionId: source.nativeSessionId }, true)).logicalSessionId; }
      catch { items.push(receipt("deferred", "来源会话的逻辑身份尚未就绪，请保留本页并重试。")); continue; }
    }
    const record = annotationMirrorRecordSchema.parse({ ...entry, source, kind: "reference-record", targetSessionId: target.logicalSessionId, sourceRevision: q.sourceRevision });
    const sameContent = old && stable({ ...old, sourceRevision: 0, ...(record.targetMessageId ? { targetMessageId: record.targetMessageId } : {}) }) === stable({ ...record, sourceRevision: 0 });
    if (old && q.sourceRevision < old.sourceRevision) {
      items.push(receipt(entry.targetMessageId && sameContent ? "unchanged" : "stale")); continue;
    }
    if (old && old.sourceRevision === q.sourceRevision && !sameContent) {
      items.push(receipt("conflict", "同一来源修订的条目内容不同；保留 Core 原记录并重新核对。")); continue;
    }
    const result = store.transaction(() => {
      // Verify the connected writer inside the durable write boundary as well.
      requireWriter(scope);
      const content = { schemaVersion: 1, title: (source.title || (entry.sourceType === "obsidian-note" ? "Obsidian 引用" : "会话引用")).slice(0, 500),
        body: record as unknown as JsonValue, references: [...new Set([target.logicalSessionId, ...(source.logicalSessionId ? [source.logicalSessionId] : [])])].map(logicalSessionId => ({ logicalSessionId })) };
      if (entry.targetMessageId && target.logicalSessionId !== initialTarget.logicalSessionId) {
        const obsoleteId = `reference-${createHash("sha256").update(JSON.stringify([scope, initialTarget.logicalSessionId, entry.referenceId])).digest("hex")}`;
        const obsolete = store.get(scope, obsoleteId);
        if (obsolete && !obsolete.deleted) {
          const previous = annotationMirrorRecordSchema.parse(obsolete.content.body);
          if (previous.setId !== entry.setId || previous.referenceId !== entry.referenceId)
            throw new Error("Reference relocation identity mismatch");
          const moved = store.write({ scope, writerId, objectId: obsoleteId, expectedRevision: obsolete.revision,
            deleted: true, content: obsolete.content });
          if (moved.status === "conflict") return moved;
        }
      }
      let revision = current?.revision ?? 0;
      // A first-seen positive deletion fences older exports too, without deleting absent peers.
      if (!current && entry.state === "deleted") {
        const first = store.write({ scope, writerId, objectId, expectedRevision: 0, deleted: false, content });
        if (first.status === "conflict") return first;
        revision = first.object.revision;
      }
      return store.write({ scope, writerId, objectId, expectedRevision: revision, deleted: entry.state === "deleted", content });
    });
    items.push(result.status === "conflict" ? receipt("conflict", "镜像修订已经变化，请重试。")
      : { referenceId: entry.referenceId, objectId, revision: result.object.revision, sourceRevision: q.sourceRevision, status: result.status });
  }
  return { items };
}
