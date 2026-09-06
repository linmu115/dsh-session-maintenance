import type { DatabaseSync } from "node:sqlite";
import { normalizeCodexProjectPath, readCodexDesktopProjectDirectory, type CodexDesktopProjectDirectory } from "@linmu/dsh-adapter-codex-read";
import { sha256Canonical } from "@linmu/dsh-session-domain";
import {
  codexProjectMappingPolicySchema, codexProjectMappingUpdateSchema,
  type CodexProjectMappingConfiguration, type CodexProjectMappingPolicy, type CodexProjectMappingUpdate,
  type MaintenanceWriteScope, type RegisteredInstance,
} from "@linmu/dsh-session-contracts";
import { IntegrationError } from "./integrations/bindings.js";
import { assertMappingRunsStopped, codexSourceKey, reconcileCodexProjectMapping } from "./codex-project-mapping-reconcile.js";

export const codexProjectKey = (instanceId: string, projectId: string): string => `${encodeURIComponent(instanceId)}:${encodeURIComponent(projectId)}`;
const emptyPolicy = (): CodexProjectMappingPolicy => ({ revision: 0, activeRevision: 0, configured: false, activeConfigured: false, projectKeys: [], activeProjectKeys: [], includeFutureSessions: true });
type Snapshot = { instance: RegisteredInstance; directory: CodexDesktopProjectDirectory };
type ObserverStatus = CodexProjectMappingConfiguration["observer"];

/** Saved intent is independent of the active scope. Only a stopped startup can activate it. */
export class CodexProjectMappingService {
  private observer: ObserverStatus = { state: "stopped", lastSyncAt: null, lastError: null };
  constructor(private readonly options: {
    database: DatabaseSync; writes: MaintenanceWriteScope; instances: readonly RegisteredInstance[];
    directory?: (instance: RegisteredInstance) => Promise<CodexDesktopProjectDirectory>;
    fixtureGuard?: (root: string) => void; clock?: () => string;
  }) {}

  readPolicy(): CodexProjectMappingPolicy {
    const row = this.options.database.prepare("SELECT policy_json FROM codex_project_mapping_policy WHERE id=1").get() as { policy_json: string } | undefined;
    return row === undefined ? emptyPolicy() : codexProjectMappingPolicySchema.parse(JSON.parse(row.policy_json));
  }
  setObserverStatus(status: ObserverStatus): void { this.observer = { ...status }; }
  private at(): string { return this.options.clock?.() ?? new Date().toISOString(); }
  private persist(policy: CodexProjectMappingPolicy): void {
    this.options.writes.assertInScope();
    this.options.database.prepare("INSERT INTO codex_project_mapping_policy (id,policy_json,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET policy_json=excluded.policy_json,updated_at=excluded.updated_at")
      .run(JSON.stringify(codexProjectMappingPolicySchema.parse(policy)), this.at());
  }
  private readDirectory(instance: RegisteredInstance): Promise<CodexDesktopProjectDirectory> {
    return this.options.directory?.(instance) ?? readCodexDesktopProjectDirectory(instance, this.options.fixtureGuard === undefined ? {} : { fixtureGuard: this.options.fixtureGuard });
  }
  private async snapshots(): Promise<Snapshot[]> {
    return Promise.all(this.options.instances.filter(instance => instance.platform === "codex").map(async instance => ({ instance, directory: await this.readDirectory(instance) })));
  }
  private assertSafe(snapshots: readonly Snapshot[], keys: readonly string[]): void {
    if (snapshots.some(item => !item.directory.safeForSelection)) throw new IntegrationError("MAPPING_DIRECTORY_UNSAFE", "Codex 项目归属暂时无法完整核实，已暂停切换名单和清理。请重新读取目录。", 503);
    const known = new Set(snapshots.flatMap(item => item.directory.projects.map(project => codexProjectKey(item.instance.id, project.projectId))));
    if (keys.some(key => !known.has(key))) throw new IntegrationError("MAPPING_PROJECT_UNKNOWN", "已保存的项目当前无法找到，请重新读取目录并更新名单。");
  }
  async get(): Promise<CodexProjectMappingConfiguration> {
    const results = await Promise.allSettled(this.options.instances.filter(instance => instance.platform === "codex").map(async instance => ({ instance, directory: await this.readDirectory(instance) })));
    const projects: CodexProjectMappingConfiguration["projects"] = [];
    const issues: string[] = [];
    for (const result of results) {
      if (result.status === "rejected") { issues.push("有 Codex 来源暂时无法读取，请检查接入状态后重新读取目录。"); continue; }
      const { instance, directory } = result.value;
      if (!directory.safeForSelection) issues.push(`${instance.displayName}：项目归属尚未完整核实，暂不可切换映射。`);
      for (const project of directory.projects) projects.push({ key: codexProjectKey(instance.id, project.projectId), instanceId: instance.id,
        projectId: project.projectId, name: project.name, roots: [...project.roots], kind: project.kind,
        sessionCount: project.memberThreadIds.length, eligible: directory.safeForSelection, issues: [...directory.issues] });
    }
    const policy = this.readPolicy();
    return { policy, projects, issues, pendingActivation: policy.configured && (!policy.activeConfigured || policy.revision !== policy.activeRevision), observer: { ...this.observer } };
  }
  async save(input: CodexProjectMappingUpdate): Promise<CodexProjectMappingConfiguration> {
    const update = codexProjectMappingUpdateSchema.parse(input);
    await this.options.writes.run("codex-project-mapping-save", async () => {
      const policy = this.readPolicy();
      if (update.revision !== policy.revision) throw new IntegrationError("MAPPING_POLICY_CHANGED", "映射名单已在别处更新，请重新读取后再保存。");
      const keys = [...new Set(update.projectKeys)].sort();
      this.assertSafe(await this.snapshots(), keys);
      this.persist({ ...policy, configured: true, revision: policy.revision + 1, projectKeys: keys });
    });
    return this.get();
  }

  /** Pass a captured saved policy only to the startup importer. Online callers always use active. */
  async readScope(instance: RegisteredInstance, saved?: CodexProjectMappingPolicy) {
    const policy = saved ?? this.readPolicy();
    const configured = saved === undefined ? policy.activeConfigured : policy.configured;
    if (!configured) return undefined;
    const keys = saved === undefined ? policy.activeProjectKeys : policy.projectKeys;
    const directory = await this.readDirectory(instance);
    if (!directory.safeForSelection) throw new IntegrationError("MAPPING_DIRECTORY_UNSAFE", "Codex 项目归属读取不完整，已暂停本轮映射。", 503);
    const available = new Map(directory.projects.map(project => [codexProjectKey(instance.id, project.projectId), project.projectId]));
    const instancePrefix = `${encodeURIComponent(instance.id)}:`;
    const relevant = keys.filter(key => key.startsWith(instancePrefix));
    if (relevant.some(key => !available.has(key))) throw new IntegrationError("MAPPING_PROJECT_UNKNOWN", "映射名单中的项目已移除或尚不可见，请重新读取目录更新名单。");
    return { revision: saved === undefined ? policy.activeRevision : policy.revision,
      projectIds: relevant.map(key => available.get(key)!), directory };
  }

  async activateForStartup(sync: (policy: CodexProjectMappingPolicy) => Promise<void>) {
    return this.options.writes.run("codex-project-mapping-activate", async () => {
      const policy = this.readPolicy();
      if (!policy.configured) return undefined;
      assertMappingRunsStopped(this.options.database);
      this.assertSafe(await this.snapshots(), policy.projectKeys);
      const database = this.options.database;
      database.exec("BEGIN IMMEDIATE");
      try {
      await sync(policy);
      // Re-read after import: a project move or newly created thread cannot be
      // treated as safely mirrored until its authoritative binding exists.
      const snapshots = await this.snapshots();
      this.assertSafe(snapshots, policy.projectKeys);
      const sourceKeys = new Set<string>();
      const projectIds = new Set<string>();
      const projectAliases = new Map<string, string>();
      const projectDefinitions: Array<{ id: string; sourceId: string; name: string; roots: readonly string[] }> = [];
      const binding = this.options.database.prepare("SELECT b.logical_session_id FROM platform_bindings b JOIN logical_sessions s ON s.id=b.logical_session_id WHERE b.platform='codex' AND b.instance_id=? AND b.session_id=? AND s.origin_kind='codex-mirror'");
      for (const { instance, directory } of snapshots) for (const project of directory.projects) {
        if (!policy.projectKeys.includes(codexProjectKey(instance.id, project.projectId))) continue;
        const canonicalId = `project-${sha256Canonical({ platform: "codex", instanceId: instance.id, sourceProjectId: project.projectId }).slice(0, 24)}`;
        projectIds.add(canonicalId);
        projectDefinitions.push({ id: canonicalId, sourceId: project.projectId, name: project.name, roots: project.roots });
        // Existing server IDs protect Maintenance-owned native records created
        // before the desktop migration; Codex mirrors still require exact IDs.
        if (project.serverProjectId !== null) {
          const oldId = `project-${sha256Canonical({ platform: "codex", instanceId: instance.id, sourceProjectId: project.serverProjectId }).slice(0, 24)}`;
          if (oldId !== canonicalId) projectAliases.set(oldId, canonicalId);
        }
        for (const sessionId of project.memberThreadIds) {
          if (binding.get(instance.id, sessionId) === undefined) throw new IntegrationError("MAPPING_IMPORT_INCOMPLETE", "所选项目有新会话尚未完成导入，已保留原数据，请再次启动重试。");
          sourceKeys.add(codexSourceKey(instance.id, sessionId));
        }
      }
        const at = this.at();
        for (const project of projectDefinitions) {
          database.prepare(`INSERT INTO logical_projects (id,name,source_platform,source_project_id,sort_key,deleted_at,created_at,updated_at)
            VALUES (?,?,'codex',?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sort_key=excluded.sort_key,deleted_at=NULL,updated_at=excluded.updated_at`)
            .run(project.id, project.name, project.sourceId, `${project.name}\0${project.id}`, at, at);
          database.prepare("DELETE FROM project_roots WHERE project_id=?").run(project.id);
          const roots = new Map(project.roots.map(path => [normalizeCodexProjectPath(path), path]));
          let ordinal = 0;
          for (const [normalized, path] of roots) database.prepare("INSERT INTO project_roots (project_id,root_path,normalized_root_path,ordinal) VALUES (?,?,?,?)").run(project.id, path, normalized, ordinal++);
        }
        const result = reconcileCodexProjectMapping(database, { selection: { sourceKeys, projectIds, projectAliases }, revision: policy.revision, at });
        this.persist({ ...policy, activeConfigured: true, activeRevision: policy.revision, activeProjectKeys: [...policy.projectKeys] });
        database.exec("COMMIT");
        return result;
      } catch (error) { try { database.exec("ROLLBACK"); } catch { /* preserve failure */ } throw error; }
    });
  }
}
