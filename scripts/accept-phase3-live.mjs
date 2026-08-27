import { spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  CodexContinuationAdapter,
  CODEX_CONTINUATION_SCHEMA_FINGERPRINT,
  StdioAppServerTransport,
} from "../packages/adapter-codex-continuation/dist/index.js";
import {
  addCodexTarget,
  createReadOnlyComposition,
  initializeStateRoot,
  probeAndAddInstance,
  startMaintenanceServer,
} from "../apps/engine/dist/index.js";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeDshFixtureHome,
} from "../packages/test-support/dist/index.js";

const EXPECTED_CODEX_VERSION = "0.146.0";
const TASK_NAME = "DSH Session Maintenance - Phase 3 Live Acceptance - 2026-08-27";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function fail(message) {
  throw new Error(message);
}

function findThread(value, threadId) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => findThread(item, threadId));
  if (value.id === threadId) return true;
  return Object.values(value).some((item) => findThread(item, threadId));
}

async function initializeTransport(transport) {
  const actualVersion = await transport.version();
  if (actualVersion !== EXPECTED_CODEX_VERSION) {
    fail(`Codex version drift: expected ${EXPECTED_CODEX_VERSION}, received ${actualVersion}`);
  }
  await transport.request("initialize", {
    clientInfo: {
      name: "dsh-session-maintenance-live-acceptance",
      title: "DSH Session Maintenance Live Acceptance",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: [],
    },
  });
  await transport.notify("initialized");
}

async function mcpRequest(pluginRoot, stateRoot, continuationId) {
  const entry = join(pluginRoot, "mcp", "server.mjs");
  await access(entry);
  const skill = await readFile(join(pluginRoot, "skills", "session-continuation", "SKILL.md"), "utf8");
  if (!skill.includes("name: dsh-session-continuation") || !skill.includes("continuation_status")) {
    fail("Installed Codex plugin skill is incomplete");
  }

  const child = spawn(process.execPath, [entry, "--stdio"], {
    cwd: pluginRoot,
    env: { ...process.env, DSH_SESSION_MAINTENANCE_STATE_ROOT: stateRoot },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const request = (id, method, params) => new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`Timed out waiting for MCP ${method}: ${stderr}`));
    }, 10_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolveRequest(value);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "phase3-live-acceptance", version: "0.1.0" },
    });
    const tools = await request(2, "tools/list", {});
    const status = await request(3, "tools/call", {
      name: "continuation_status",
      arguments: { continuationId },
    });
    const text = status.result?.content?.[0]?.text;
    const parsed = typeof text === "string" ? JSON.parse(text) : undefined;
    if (initialized.result?.serverInfo?.name !== "dsh-session-maintenance") fail("Unexpected MCP server identity");
    if (!tools.result?.tools?.some((tool) => tool.name === "continuation_status")) fail("MCP status tool is missing");
    if (parsed?.continuation?.id !== continuationId || parsed.continuation.status !== "completed") {
      fail("Installed MCP did not resolve the Engine continuation job");
    }
    return { skillLoaded: true, mcpStatusJobId: parsed.continuation.id };
  } finally {
    child.stdin.end();
    await new Promise((resolveExit) => {
      const timer = setTimeout(() => { child.kill(); resolveExit(); }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
  }
}

async function main() {
  if (!process.argv.includes("--confirm-create")) {
    fail("Live creation requires --confirm-create");
  }
  const pluginRootArgument = argument("--installed-plugin-root");
  if (pluginRootArgument === undefined) fail("--installed-plugin-root is required");
  const pluginRoot = await realpath(resolve(pluginRootArgument));
  const codexHome = await realpath(resolve(argument("--codex-home") ?? join(homedir(), ".codex")));
  const workspace = await realpath(resolve(argument("--workspace") ?? process.cwd()));

  const target = {
    id: "codex-live-acceptance",
    codexInstanceId: "codex-main",
    platformVersion: EXPECTED_CODEX_VERSION,
    codexHome,
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
    contextWindowTokens: 120_000,
    inputBudgetRatio: 0.2,
  };
  const probeAdapter = new CodexContinuationAdapter();
  const probe = await probeAdapter.probe(target);
  await probeAdapter.close();
  if (probe.status !== "compatible" || probe.schemaFingerprint !== CODEX_CONTINUATION_SCHEMA_FINGERPRINT) {
    fail(`Codex continuation contract is incompatible: ${JSON.stringify(probe)}`);
  }

  const sandbox = await createFixtureSandbox("phase3-live");
  const stateRoot = join(sandbox.root, "maintenance-state");
  let engine;
  let server;
  let inspection;
  try {
    await writeDshFixtureHome(sandbox.dshHome);
    await initializeStateRoot(stateRoot);
    await probeAndAddInstance({ stateRoot, fixturePolicy: assertFixtureSandbox }, {
      id: "dsh-live-source",
      platform: "dsh",
      displayName: "Phase 3 controlled DSH source",
      root: sandbox.dshHome,
      platformVersion: "0.1.1-rc.2",
    });
    await probeAndAddInstance({ stateRoot }, {
      id: "codex-main",
      platform: "codex",
      displayName: "Real Codex Home",
      root: codexHome,
      platformVersion: EXPECTED_CODEX_VERSION,
    });
    await addCodexTarget(stateRoot, {
      id: target.id,
      codexInstanceId: target.codexInstanceId,
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      contextWindowTokens: target.contextWindowTokens,
      inputBudgetRatio: target.inputBudgetRatio,
    });

    engine = await createReadOnlyComposition({ stateRoot });
    await engine.scan({ instanceIds: ["dsh-live-source"] });
    const sessions = await engine.listSessions({ platform: "dsh", limit: 10 });
    if (sessions.items.length !== 1) fail(`Expected one controlled DSH session, found ${sessions.items.length}`);
    const logicalSessionId = sessions.items[0].logicalSessionId;
    const graph = await engine.getGraph(logicalSessionId);
    if (graph.nodes.length !== 1) fail(`Expected one controlled source version, found ${graph.nodes.length}`);
    const sourceVersionId = graph.nodes[0].id;
    const request = {
      logicalSessionId,
      sourceVersionId,
      targetPresetId: target.id,
      mode: "full",
    };
    const preview = await engine.previewContinuation(request);
    if (!preview.allowed) fail(`Live preview was rejected: ${preview.reason ?? "unknown"}`);

    const created = await engine.createContinuation(request);
    if (created.status !== "completed" || created.codexThreadId === undefined) {
      fail(`Live continuation did not complete: ${JSON.stringify(created)}`);
    }
    const repeated = await engine.createContinuation(request);
    if (repeated.id !== created.id || repeated.codexThreadId !== created.codexThreadId) {
      fail("Idempotent retry created or selected a different continuation");
    }

    inspection = new StdioAppServerTransport(target);
    await initializeTransport(inspection);
    await inspection.request("thread/name/set", { threadId: created.codexThreadId, name: TASK_NAME });
    const read = await inspection.request("thread/read", { threadId: created.codexThreadId, includeTurns: false });
    const resumed = await inspection.request("thread/resume", { threadId: created.codexThreadId });
    const listed = await inspection.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    });
    if (read?.thread?.id !== created.codexThreadId || read.thread.historyMode !== "paginated" || read.thread.ephemeral) {
      fail("thread/read did not return persistent paginated task metadata");
    }
    if (resumed?.thread?.id !== created.codexThreadId || !Array.isArray(resumed.thread.turns) || resumed.thread.turns.length === 0) {
      fail("thread/resume did not reopen the persisted initial turn");
    }
    if (!findThread(listed, created.codexThreadId)) fail("thread/list did not discover the created task");

    server = await startMaintenanceServer({ engine, stateRoot, host: "127.0.0.1", port: 0 });
    const plugin = await mcpRequest(pluginRoot, stateRoot, created.id);
    const result = {
      passed: true,
      codexVersion: EXPECTED_CODEX_VERSION,
      schemaFingerprint: probe.schemaFingerprint,
      isolatedMaintenanceState: true,
      controlledDshSource: true,
      preview: {
        allowed: preview.allowed,
        estimatedTokens: preview.estimatedTokens,
        tokenBudget: preview.tokenBudget,
      },
      continuationJobId: created.id,
      codexThreadId: created.codexThreadId,
      codexTurnId: created.codexTurnId,
      taskName: TASK_NAME,
      read: true,
      resume: true,
      discover: true,
      idempotentRetry: true,
      plugin,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await server?.close();
    await inspection?.close();
    engine?.close();
    await sandbox.cleanup();
  }
}

await main();
