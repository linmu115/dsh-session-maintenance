import {
  SessionMaintenanceError,
  normalizedSessionSchema,
  type Checkpoint,
  type CheckpointRestoreCapability,
  type ContentObjectStore,
  type NormalizedSession,
  type PlatformBinding,
  type PlatformSessionKey,
  type SessionRepository,
  type SessionVersionManifest,
  type TransactionRepository,
} from "@linmu/dsh-session-contracts";
import { normalizedSessionHashes } from "@linmu/dsh-session-domain";

type SourceRepository = Pick<SessionRepository, "getVersion" | "findBinding"> &
  Pick<TransactionRepository, "getCheckpoint">;

class CheckpointRestoreSourceError extends SessionMaintenanceError {}

interface CheckpointRestoreSource {
  readonly checkpoint: Checkpoint;
  readonly version: SessionVersionManifest;
  readonly binding: PlatformBinding;
  readonly source: NormalizedSession;
}

function sameKey(left: PlatformSessionKey, right: PlatformSessionKey): boolean {
  return left.platform === right.platform && left.instanceId === right.instanceId && left.sessionId === right.sessionId;
}

/** Only reads persisted source data. It never probes a target or creates a plan. */
export async function loadCheckpointRestoreSource(
  repository: SourceRepository,
  objectStore: Pick<ContentObjectStore, "get">,
  checkpointId: string,
): Promise<CheckpointRestoreSource> {
  const checkpoint = await repository.getCheckpoint(checkpointId);
  if (checkpoint === undefined) {
    throw new CheckpointRestoreSourceError("OBJECT_CORRUPT", "恢复点不存在或已被移除。");
  }
  const refs = Object.entries(checkpoint.refs);
  const sessionRefs = refs.filter(([name]) => name.startsWith("session:"));
  const selected = sessionRefs.length === 1 ? sessionRefs[0] : refs.length === 1 ? refs[0] : undefined;
  if (selected === undefined) {
    throw new CheckpointRestoreSourceError("IDENTITY_CONFLICT", "恢复点必须能唯一确定一个会话版本，当前无法生成恢复预览。");
  }
  const version = await repository.getVersion(selected[1]);
  if (version === undefined || version.id !== selected[1]) {
    throw new CheckpointRestoreSourceError("OBJECT_CORRUPT", "恢复点引用的会话版本缺失或不一致。");
  }
  if (selected[0].startsWith("session:") && selected[0].slice("session:".length) !== version.logicalSessionId) {
    throw new CheckpointRestoreSourceError("IDENTITY_CONFLICT", "恢复点的会话引用与保存版本不一致。");
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(await objectStore.get(version.bodyObject)).toString("utf8"));
  } catch {
    throw new CheckpointRestoreSourceError("OBJECT_CORRUPT", "恢复点的会话内容缺失、损坏或无法读取。");
  }
  // Canonical bodies deliberately omit the platform-session envelope required
  // by the legacy restore planner. The canonical writer also records its own
  // source namespace; neither format may enter the legacy planner.
  const canonicalBody = typeof body === "object" && body !== null && !Array.isArray(body) &&
    "schemaVersion" in body && body.schemaVersion === 1 && "events" in body &&
    Array.isArray(body.events) && "workspaceId" in body && !("key" in body);
  if (version.source.instanceId === "canonical-projection" || canonicalBody) {
    throw new CheckpointRestoreSourceError("CAPABILITY_NOT_AVAILABLE", "此恢复点保存的是 Canonical 会话保护数据，当前旧版恢复预览尚不支持此格式。");
  }
  const parsed = normalizedSessionSchema.safeParse(body);
  if (!parsed.success) {
    throw new CheckpointRestoreSourceError("OBJECT_CORRUPT", "恢复点的会话内容格式无效，无法生成恢复预览。");
  }
  const source = parsed.data as unknown as NormalizedSession;
  const hashes = normalizedSessionHashes(source);
  if (source.bodyHash !== version.bodyHash || source.metadataHash !== version.metadataHash ||
      hashes.bodyHash !== source.bodyHash || hashes.metadataHash !== source.metadataHash) {
    throw new CheckpointRestoreSourceError("OBJECT_CORRUPT", "恢复点会话内容的摘要与保存版本不一致，可能引用了错误对象或内容已损坏。");
  }
  const binding = await repository.findBinding(version.source);
  if (binding === undefined || binding.logicalSessionId !== version.logicalSessionId ||
      !sameKey(binding.key, version.source) || !sameKey(source.key, version.source)) {
    throw new CheckpointRestoreSourceError("IDENTITY_CONFLICT", "恢复点的来源绑定缺失，或与保存的会话版本不一致。");
  }
  return { checkpoint, version, binding, source };
}

export async function checkpointRestoreCapability(
  repository: SourceRepository,
  objectStore: Pick<ContentObjectStore, "get">,
  checkpointId: string,
): Promise<CheckpointRestoreCapability> {
  try {
    await loadCheckpointRestoreSource(repository, objectStore, checkpointId);
    return {
      checkpointId,
      supported: true,
      reason: "已保存的会话版本支持恢复预览；目标是否可写仍需在选择目标后检查，尚未执行恢复。",
    };
  } catch (error) {
    return {
      checkpointId,
      supported: false,
      reason: error instanceof CheckpointRestoreSourceError ? error.message : "无法读取并核对恢复点的源版本，当前不能生成恢复预览。",
    };
  }
}
