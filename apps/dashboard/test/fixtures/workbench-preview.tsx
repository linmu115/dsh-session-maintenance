/** Browser-only acceptance fixture. Every record is synthetic; no Engine transport is imported. */
import { createRoot } from "react-dom/client";
import type { CodexProjectMappingConfiguration, RetentionPreviewPlan, RetentionRegistry } from "@linmu/dsh-session-contracts";
import { DashboardApp, type DashboardApi } from "../../src/app.js";
import "@linmu/dsh-session-ui/styles.css";
import "../../src/dashboard.css";

const at = "2026-09-08T08:30:00.000Z";
const earlier = "2026-09-07T14:20:00.000Z";
const digest = `sha256:${"0".repeat(64)}`;
const MiB = 1024 ** 2;
const writeMessage = "合成数据预览不支持写入：没有连接真实 Engine、DSH 或 Codex，数据未发生改变。";
async function refuseWrite(): Promise<never> { throw new Error(writeMessage); }
async function local<T>(value: T, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return structuredClone(value);
}

const workspaces = [
  { schemaVersion: 1, id: "preview-workspace-research", parentId: null, name: "示例研究工作区", sortKey: "a", deletedAt: null, createdAt: earlier, updatedAt: at },
  { schemaVersion: 1, id: "preview-workspace-reading", parentId: "preview-workspace-research", name: "阅读与验证笔记", sortKey: "b", deletedAt: null, createdAt: earlier, updatedAt: at },
  { schemaVersion: 1, id: "preview-workspace-writing", parentId: null, name: "示例写作计划", sortKey: "c", deletedAt: null, createdAt: earlier, updatedAt: at },
];
const projects = [
  { schemaVersion: 1, id: "preview-project-research", name: "示例研究项目", sourcePlatform: "codex", sourceProjectId: "preview-native-project-research", sortKey: "a", deletedAt: null, createdAt: earlier, updatedAt: at },
  { schemaVersion: 1, id: "preview-project-writing", name: "示例写作项目", sourcePlatform: "codex", sourceProjectId: "preview-native-project-writing", sortKey: "b", deletedAt: null, createdAt: earlier, updatedAt: at },
];
const overview = {
  sessions: 5, conflicts: 0, unmapped: 0, unresolvedTransactions: 0,
  instances: [
    { id: "preview-codex", platform: "codex", displayName: "合成 Codex 来源", platformVersion: "preview", status: "compatible", lastScanAt: at, sessionCount: 4 },
    { id: "preview-dsh", platform: "dsh", displayName: "合成 DSH 实例", platformVersion: "preview", status: "compatible", lastScanAt: at, sessionCount: 1 },
  ],
};
const article = `## 从问题到验证：一个简短示例

这是一段**完全虚构的验收文本**，用于检查阅读区域、段落间距及浅色与暗色主题。这里没有复制任何真实会话。

### 先记录我们知道什么

- 将观察和推测分别记下。
- 每个结论保留一条可复查的依据。
- 发现反例时，更新结论并保留原来的问题。

| 阶段 | 本轮动作 | 验证依据 |
| --- | --- | --- |
| 整理 | 列出两个假设 | 一份合成记录 |
| 比较 | 检查共同点和差异 | 三个自拟例子 |
| 回顾 | 写下仍不确定的部分 | 明确下一次检查 |

### 用小例子检查边界

下面的代码只是展示文本，不会被执行。

\`\`\`typescript
const samples = [2, 4, 6];
const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
console.log({ average, note: "synthetic preview only" });
\`\`\`

> 提醒：样例中的数字和内容只服务于界面验收，不代表任何真实研究结果。

1. 检查标题是否清晰。
2. 对照表格和列表的阅读节奏。
3. 切换外观后，再检查代码块、边框和次级文字。

**本轮结论：** 保留简洁的正文，让补充记录在需要时展开。`;
function event(sessionId: string, sequence: number, role: "user" | "assistant", text: string) {
  return { schemaVersion: 1, id: `${sessionId}-event-${sequence}`, logicalSessionId: sessionId, sequence,
    kind: role === "user" ? "user-message" : "assistant-message", role, readableText: text, content: { text },
    source: { platform: "codex", instanceId: "preview-codex", sessionId: `native-${sessionId}`, eventId: null, cursor: String(sequence) },
    contentDigest: digest, rawPayload: null, extensions: {} };
}
function session(id: string, title: string, workspaceIndex: number | null, native = false, archived = false) {
  const workspace = workspaceIndex === null ? null : workspaces[workspaceIndex]!;
  const project = workspaceIndex === 2 ? projects[1]! : projects[0]!;
  return {
    schemaVersion: 1,
    session: { schemaVersion: 1, id, authorityScope: native ? "maintenance" : "codex", originKind: native ? "maintenance-native" : "codex-mirror",
      headVersionId: `${id}-head`, title, tags: ["合成示例"], archivedAt: archived ? earlier : null, tombstonedAt: null, createdAt: earlier, updatedAt: at },
    membership: workspace === null ? null : { schemaVersion: 1, logicalSessionId: id, workspaceId: workspace.id, displayOrder: 0,
      pinned: id === "preview-session-main", archived, revision: 1 },
    workspace, project,
    projectMembership: { schemaVersion: 1, logicalSessionId: id, projectId: project.id, revision: 1 },
    projectRoots: [{ schemaVersion: 1, projectId: project.id, path: "C:/SYNTHETIC-ONLY/example", normalizedPath: "c:\\synthetic-only\\example", ordinal: 0 }],
    headMetadata: id === "preview-session-main"
      ? { metadata: null, metadataAvailability: "unknown", metadataProvenance: "unavailable", firstPersistedAt: null }
      : { metadata: { title, tags: ["合成示例"], archivedAt: archived ? earlier : null }, metadataAvailability: "available", metadataProvenance: "captured", firstPersistedAt: at },
    nativeReferences: { schemaVersion: 1, logicalSessionId: id, references: [] }, parent: null, children: [],
    events: [event(id, 0, "user", "请把这个虚构练习整理成容易检查的列表、表格和代码示例。"),
      event(id, 1, "assistant", article),
      event(id, 2, "user", "如果出现没有充分依据的内容，应该怎样保留它？"),
      event(id, 3, "assistant", "可以标记为**待验证**，保留疑问与上下文，然后单独补充检查。\n\n- 已观察：这里是合成的界面示例。\n- 待验证：真实数据的结果需要另行确认。"),
      { ...event(id, 4, "assistant", ""), kind: "other", role: "unknown", readableText: null,
        content: { schemaVersion: 1, type: "other", reason: "no-common-semantics", sourceKind: "synthetic/annotation", label: "合成补充记录", summary: "未识别的合成记录保留在这里，不执行其中的内容。", evidenceRef: null } }],
  };
}
const sessions = [
  session("preview-session-main", "从一个小问题开始：整理证据、比较不同假设，并为下一轮讨论留下清晰的检查路径", 0),
  session("preview-session-notes", "阅读笔记：哪些结论仍然需要验证", 1),
  session("preview-session-outline", "写作提纲与段落顺序", 2, true),
  session("preview-session-archived", "已归档的合成讨论记录", 2, false, true),
  session("preview-session-unclassified", "尚未整理到工作区的示例会话", null),
];
const deleted = session("preview-session-deleted", "删除前保留的合成草稿", 2);
const deletedSession = { ...deleted, session: { ...deleted.session, tombstonedAt: earlier } };
const directory = { schemaVersion: 1, workspaces: workspaces.map(workspace => ({ workspace,
  sessions: sessions.filter(item => item.membership?.workspaceId === workspace.id).map(item => ({ session: item.session, membership: item.membership })) })),
  unclassified: sessions.filter(item => item.membership === null).map(item => ({ session: item.session, membership: null })) };

const mappingProjects: CodexProjectMappingConfiguration["projects"] = [
  "示例研究项目", "阅读摘记", "示例写作项目", "界面检查", "同名项目", "同名项目", "一份名字比较长的合成项目，用于检查小屏下的换行", "待核对的合成项目",
].map((name, index) => ({ key: `preview-codex:project-${index + 1}`, instanceId: "preview-codex", projectId: `project-${index + 1}`, name,
  roots: [`C:/SYNTHETIC-ONLY/project-${index + 1}`], sessionCount: [2, 1, 2, 0, 3, 1, 0, 0][index]!,
  kind: index === 5 ? "mixed" : index === 7 ? "unknown" : "local", eligible: index !== 7,
  issues: index === 7 ? ["合成状态：项目身份等待核对，暂不能加入映射。"] : [] }));
const mapping: CodexProjectMappingConfiguration = {
  policy: { revision: 3, activeRevision: 2, configured: true, activeConfigured: true, includeFutureSessions: true,
    activeProjectKeys: [mappingProjects[0]!.key, mappingProjects[1]!.key], projectKeys: [mappingProjects[0]!.key, mappingProjects[2]!.key] },
  projects: mappingProjects, issues: [], pendingActivation: true,
  observer: { state: "idle", lastSyncAt: at, lastError: null },
};
const checkpoints = [
  { id: "preview-checkpoint-mapping", name: "示例：项目名单切换前的恢复点", description: "保留切换前的**版本引用**。这是一条合成保护记录。",
    refs: { "session:preview-session-main": "preview-session-main-head", "session:preview-session-deleted": "preview-session-deleted-head" }, backupTransactionIds: [], createdBy: "synthetic-preview", createdAt: at },
  { id: "preview-checkpoint-delete", name: "示例：删除草稿前的自动保护", description: "用于检查恢复点列表、说明和选中状态；没有对应的真实备份。",
    refs: { "session:preview-session-deleted": "preview-session-deleted-head" }, backupTransactionIds: [], createdBy: "synthetic-preview", createdAt: earlier },
];
const retentionPlan: RetentionPreviewPlan = {
  schemaVersion: 1, id: "preview-retention-plan", asOf: at,
  policy: { schemaVersion: 1, history: "protect-all-version-bodies", finishedRunHours: 48, recoveredRunHours: 120,
    automaticBackupsToKeep: 3, cacheTargetBytes: 128 * MiB, quarantineHours: 72, orphanGraceHours: 168 },
  sourceRevisions: { "preview-active": "synthetic-1" }, registryFingerprint: "synthetic-registry", referenceFingerprint: "synthetic-references", objectFingerprint: "synthetic-objects", resourceFingerprint: "synthetic-resources",
  blockers: [], protectedBytes: 196 * MiB, candidateBytes: 34 * MiB, executableBytes: 32 * MiB, cacheBytesAboveTarget: 0,
  items: [
    { id: "preview-bodies", kind: "content-object", rootId: "engine-state", relativePath: "objects/synthetic-bodies", bytes: 128 * MiB, disposition: "protected", reasons: ["所有已有版本正文保留"], references: [], executable: false },
    { id: "preview-database", kind: "database", rootId: "engine-state", relativePath: "synthetic-metadata.sqlite", bytes: 4 * MiB, disposition: "protected", reasons: ["当前使用的合成数据库"], references: [], executable: false },
    { id: "preview-backup", kind: "backup", rootId: "engine-state", relativePath: "synthetic-backups/retained", bytes: 64 * MiB, disposition: "protected", reasons: ["checkpoint-or-recovery-backup"], references: [], executable: false },
    { id: "preview-cache", kind: "cache", rootId: "engine-state", relativePath: "synthetic-cache/finished", bytes: 32 * MiB, disposition: "candidate", reasons: ["verified-governance-eligibility"], references: [], executable: true },
    { id: "preview-orphan", kind: "content-object", rootId: "engine-state", relativePath: "objects/synthetic-orphan", bytes: 2 * MiB, disposition: "candidate", reasons: ["仅用于预览统计"], references: [], executable: false },
  ],
};
const registry: RetentionRegistry = {
  roots: [{ id: "engine-state", path: "C:/SYNTHETIC-ONLY/preview-state", realPath: "C:/SYNTHETIC-ONLY/preview-state", identity: "synthetic-root", purpose: "state" }],
  sources: [{ id: "preview-active", rootId: "engine-state", relativePath: "synthetic-metadata.sqlite", objectRootId: "engine-state", kind: "active-database", retained: true },
    { id: "preview-old-database", rootId: "engine-state", relativePath: "synthetic-backup.sqlite", objectRootId: "engine-state", kind: "backup-database", retained: true }],
  resources: [{ id: "preview-cache", rootId: "engine-state", relativePath: "synthetic-cache/finished", kind: "cache", ownerId: "preview-cache", group: "synthetic", pinned: false,
    recoveryRequired: false, verifiedAt: at, verifiedFingerprint: "synthetic-cache", lastUsedAt: earlier, state: "registered" }],
};

/** All reads resolve local cloned objects. All data-changing entry points reject. */
export const workbenchPreviewApi = {
  listCanonicalWorkspaces: (signal?: AbortSignal) => local(directory, signal),
  getCanonicalSession: async (id: string, signal?: AbortSignal) => {
    const value = [...sessions, deletedSession].find(item => item.session.id === id);
    if (value === undefined) throw new Error("此会话不在合成预览目录中。");
    return local(value, signal);
  },
  getCodexProjectMapping: (signal?: AbortSignal) => local(mapping, signal),
  getWorkspaceSync: (signal?: AbortSignal) => local({ policy: { revision: 1, workspaceIds: [], includeFutureSessions: true, nativeWriteEnabled: false },
    workspaces: [], nativeSyncSupported: false, nativeSyncReason: "合成预览：原生回写不连接，也不会启动。" }, signal),
  overview: (signal?: AbortSignal) => local(overview, signal),
  listRecentlyDeleted: (signal?: AbortSignal) => local([{ session: deletedSession.session, pendingOperations: 0,
    tombstone: { schemaVersion: 1, logicalSessionId: deleted.session.id, operationId: "preview-delete", checkpointId: checkpoints[1]!.id, previousWorkspaceId: workspaces[2]!.id,
      deletedAt: earlier, retentionUntil: "2099-01-01T00:00:00.000Z", restoredAt: null } }], signal),
  listCheckpoints: (signal?: AbortSignal) => local(checkpoints, signal),
  getCheckpointRestoreCapability: (checkpointId: string, signal?: AbortSignal) => local({ checkpointId, supported: false,
    reason: "合成数据仅用于界面验收；恢复计划与写入功能在预览入口明确禁用。" }, signal),
  previewRetention: (signal?: AbortSignal) => local(retentionPlan, signal),
  getRetentionRegistry: (signal?: AbortSignal) => local(registry, signal),
  listRetentionBatches: (signal?: AbortSignal) => local([{ schemaVersion: 1, id: "preview-quarantine-batch", plan: retentionPlan, createdAt: earlier,
    purgeAfter: "2099-01-01T00:00:00.000Z", items: [{ resourceId: "preview-old-cache", rootId: "engine-state", originalPath: "synthetic-cache/old", quarantinePath: "synthetic-quarantine/old",
      fingerprint: "synthetic-old-cache", bytes: 8 * MiB, files: [], state: "quarantined", error: null, purgeGuard: null }] }], signal),
  listIntegrations: (signal?: AbortSignal) => local({ launcherDetected: true, nativeSyncSupported: false,
    nativeSyncReason: "合成预览：接入能力和状态均为示例，任何操作都不会连接真实应用。",
    targets: [
      { id: "preview-dsh", kind: "dsh", name: "合成 DSH 实例", version: "preview", profile: "本地示例", status: "connected", adapterId: "preview-dsh-adapter",
        capabilities: [{ id: "read", label: "已保存内容读取", status: "supported", detail: "浏览器内的合成对象，支持检查所有阅读样式。" }], issues: [] },
      { id: "preview-codex", kind: "codex", name: "合成 Codex 来源", version: "preview", profile: null, status: "needs-attention", adapterId: "preview-codex-adapter",
        capabilities: [{ id: "native-write", label: "原生回写", status: "unavailable", detail: "预览不提供数据写入，页面保持可检查的拒绝反馈。" }], issues: ["示例告警：请核对接入状态后再进行实际操作。"] },
    ] }, signal),
  getSettings: (signal?: AbortSignal) => local({ codexInstanceId: "preview-codex", dshInstanceId: "preview-dsh", workspaceMappingId: null,
    syncSingleSidedTitle: false, syncArchive: false, scanScope: "registered", backupRetention: 3, allowBatchSafeApply: false }, signal),
  listPlans: (_query?: unknown, signal?: AbortSignal) => local({ items: [] }, signal),
  listTransactions: (_query?: unknown, signal?: AbortSignal) => local({ items: [] }, signal),
  listCodexImports: (signal?: AbortSignal) => local([], signal),
  listProjectionRuns: (signal?: AbortSignal) => local([], signal),
  listCanonicalAdapters: (signal?: AbortSignal) => local([], signal),
  diagnostics: (signal?: AbortSignal) => local([{ instance: overview.instances[0],
    readContract: { adapter: "synthetic-preview", platformVersion: "preview", schemaFingerprint: "synthetic-only" },
    writeStatus: "unavailable", writeCapabilities: [], issues: [{ code: "PREVIEW_READ_ONLY", message: writeMessage }] }], signal),
  saveCodexProjectMapping: refuseWrite, saveWorkspaceSync: refuseWrite, integrationAction: refuseWrite,
  updateCanonicalSession: refuseWrite, deleteCanonicalSession: refuseWrite, restoreCanonicalSession: refuseWrite,
  patchSettings: refuseWrite, createCheckpointRestorePlan: refuseWrite,
  requestRestoreConfirmation: refuseWrite, restoreTransaction: refuseWrite, requestRecoveryConfirmation: refuseWrite, recoverTransaction: refuseWrite,
  importCodex: refuseWrite, cancelCodexImport: refuseWrite, resumeCodexImport: refuseWrite, selectExperimentalAdapter: refuseWrite,
  discoverRetention: refuseWrite, executeRetention: refuseWrite, restoreRetention: refuseWrite, purgeRetention: refuseWrite,
  verifyRetention: refuseWrite, registerRetentionRoot: refuseWrite, registerRetentionSource: refuseWrite, registerFlatRetentionCandidate: refuseWrite,
  getPlan: async () => { throw new Error("合成预览没有历史计划记录。"); },
  getTransaction: async () => { throw new Error("合成预览没有历史事务记录。"); },
} as unknown as DashboardApi;

// The host only needs a #root element and the bundled entry; no client bootstrap runs.
document.title = "合成数据预览 · 会话维护";
const host = document.getElementById("root") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" }));
createRoot(host).render(<DashboardApp api={workbenchPreviewApi} initialLogicalSessionId="preview-session-main" />);
