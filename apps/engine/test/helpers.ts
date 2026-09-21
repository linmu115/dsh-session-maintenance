import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import type { CodexContinuationPort, LogicalWorkspaceId } from "@linmu/dsh-session-contracts";
import { SqliteInstanceWorkspacePolicyRepository } from "@linmu/dsh-session-store";

import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  writeDshFixtureHome,
} from "../../../packages/test-support/src/index.js";
import { runCli as executeCli } from "../src/cli.js";
import { createReadOnlyComposition, probeAndAddInstance } from "../src/composition-root.js";
import { addCodexTarget } from "../src/config.js";
import { startMaintenanceServer } from "../src/http/server.js";
import type { SessionMaintenanceEngine } from "../src/engine.js";
import { SqliteRuntimeProjectResolver } from "../src/runtime-project-resolver.js";

/**
 * The instance-side "将当前工作区加入 sessionmaintenance" entry is not implemented yet, so tests
 * reproduce its durable effect at the repository layer: a Maintenance workspace exists, the
 * instance/project binding points at it, and the instance's saved selection already includes it.
 * An instance synchronises exactly these explicitly joined workspaces and nothing else; call this
 * before the run is prepared, because a run freezes the scope it starts with.
 */
export async function joinInstanceWorkspace(
  engine: SessionMaintenanceEngine,
  input: { readonly instanceId: string; readonly cwd: string; readonly workspaceId?: string },
): Promise<LogicalWorkspaceId> {
  const database = engine.repository.database;
  const projectId = await new SqliteRuntimeProjectResolver(database).ensureLocalProject(input.cwd);
  const workspaceId = (input.workspaceId ?? `workspace-joined-${createHash("sha256")
    .update(JSON.stringify([input.instanceId, projectId])).digest("hex").slice(0, 32)}`) as LogicalWorkspaceId;
  const at = new Date().toISOString();
  const name = basename(input.cwd) || input.cwd;
  database.prepare("INSERT INTO logical_workspaces(id,parent_id,name,sort_key,created_at,updated_at) VALUES (?,NULL,?,?,?,?)")
    .run(workspaceId, name, name, at, at);
  database.prepare("INSERT INTO runtime_workspace_bindings(instance_id,project_id,workspace_id) VALUES (?,?,?)")
    .run(input.instanceId, projectId, workspaceId);
  const policies = new SqliteInstanceWorkspacePolicyRepository(database);
  const current = policies.getPolicy(input.instanceId);
  if (current.selection.kind === "ids" && !current.selection.workspaceIds.includes(workspaceId))
    policies.updatePolicy(input.instanceId, { expectedRevision: current.revision,
      selection: { ...current.selection, workspaceIds: [...current.selection.workspaceIds, workspaceId].sort() } });
  return workspaceId;
}

/** Explicit "全部工作区及未分组会话" selection: the widest scope the Maintenance panel offers. */
export function selectAllWorkspaces(engine: SessionMaintenanceEngine, instanceId: string): void {
  const policies = new SqliteInstanceWorkspacePolicyRepository(engine.repository.database);
  const current = policies.getPolicy(instanceId);
  if (current.selection.kind !== "all")
    policies.updatePolicy(instanceId, { expectedRevision: current.revision, selection: { kind: "all" } });
}

/** Explicit "包含未分组会话" selection; sessions without a workspace need this to be in scope. */
export function selectUnassignedSessions(engine: SessionMaintenanceEngine, instanceId: string): void {
  const policies = new SqliteInstanceWorkspacePolicyRepository(engine.repository.database);
  const current = policies.getPolicy(instanceId);
  if (current.selection.kind === "ids" && !current.selection.includeUnassigned)
    policies.updatePolicy(instanceId, { expectedRevision: current.revision,
      selection: { ...current.selection, includeUnassigned: true } });
}

export async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(relative(root, path).replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(await readFile(path));
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

export async function createFixtureSystem(name: string) {
  const sandbox = await createFixtureSandbox(name);
  await writeCodexFixtureHome(sandbox.codexHome);
  await writeDshFixtureHome(sandbox.dshHome);
  const stateRoot = join(sandbox.root, "state");
  await mkdir(stateRoot);
  return {
    ...sandbox,
    stateRoot,
    platformRoot: sandbox.codexHome,
    fixturePolicy: assertFixtureSandbox,
  };
}

export async function runCli(argv: readonly string[], fixture: Awaited<ReturnType<typeof createFixtureSystem>>) {
  let stdout = "";
  let stderr = "";
  const exitCode = await executeCli(argv, {
    fixturePolicy: fixture.fixturePolicy,
    inspectCodexEnvironment: async () => ({ compatible: true, bidirectional: false, reason: 'Synthetic fixture only' }),
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { exitCode, stdout, stderr };
}

export async function createEngineFixture(name: string, input: {
  readonly continuationAdapter?: CodexContinuationPort;
  readonly withContinuationTarget?: boolean;
  readonly enableCodexMirror?: boolean;
} = {}) {
  const fixture = await createFixtureSystem(name);
  const options = { stateRoot: fixture.stateRoot, fixturePolicy: fixture.fixturePolicy };
  await probeAndAddInstance(options, {
    id: "codex-fixture",
    platform: "codex",
    displayName: "Codex fixture",
    root: fixture.codexHome,
    platformVersion: "0.146.0",
  });
  if (input.withContinuationTarget === true) {
    await probeAndAddInstance(options, {
      id: "dsh-fixture",
      platform: "dsh",
      displayName: "DSH fixture",
      root: fixture.dshHome,
      platformVersion: "0.1.1-rc.2",
    });
    await addCodexTarget(fixture.stateRoot, {
      id: "codex-default",
      codexInstanceId: "codex-fixture",
      cwd: fixture.root,
      runtimeWorkspaceRoots: [fixture.root],
      contextWindowTokens: 120_000,
      inputBudgetRatio: 0.8,
    });
  }
  const engine = await createReadOnlyComposition({
    ...options,
    inspectCodexEnvironment: async () => ({ compatible: true, bidirectional: false, reason: 'Synthetic fixture only' }),
    ...(input.continuationAdapter === undefined ? {} : { continuationAdapter: input.continuationAdapter }),
  });
  if (input.enableCodexMirror !== false) {
    await engine.codexMirror!.configure({ ...engine.codexMirror!.status().preferences, instanceId: 'codex-fixture' });
    await engine.codexMirror!.check();
    await engine.codexMirror!.configure({ ...engine.codexMirror!.status().preferences, mirror: true });
  }
  const servers: Array<{ close: () => Promise<void> }> = [];
  return {
    ...fixture,
    engine,
    startServer: async (input: { readonly host?: string; readonly port?: number; readonly dashboardRoot?: string } = {}) => {
      const server = await startMaintenanceServer({ engine, stateRoot: fixture.stateRoot, ...input, skipAcl: true });
      servers.push(server);
      return server;
    },
    stop: async () => {
      await Promise.all(servers.splice(0).map((server) => server.close()));
      engine.close();
    },
    cleanupAll: async () => {
      await Promise.all(servers.splice(0).map((server) => server.close()));
      engine.close();
      await fixture.cleanup();
    },
  };
}
