import { resolve } from "node:path";

import { Command, CommanderError, Option } from "commander";
import {
  SessionMaintenanceError,
  type ContinuationMode,
  type ContinuationPreviewRequest,
  type JsonValue,
  type PlatformKind,
  type ResolutionContinuationRequest,
} from "@linmu/dsh-session-contracts";

import {
  createDshWritableComposition,
  createReadOnlyComposition,
  probeAndAddInstance,
  type CompositionOptions,
} from "./composition-root.js";
import { reseedCanonicalCandidate } from "./canonical-reseed.js";
import type { DshGatewayTarget } from "./dsh-gateway-connection.js";
import {
  addCodexTarget,
  initializeStateRoot,
  loadConfig,
  registeredCodexTargets,
  registeredInstances,
} from "./config.js";
import { startMaintenanceServer } from "./http/server.js";

export interface CliOptions {
  readonly fixturePolicy?: (root: string) => void;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly clock?: () => string;
}

function output(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function gatewayTargets(values: readonly string[]): readonly DshGatewayTarget[] {
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new TypeError(`Invalid DSH gateway target; expected instanceId=http://127.0.0.1:port: ${value}`);
    }
    return { instanceId: value.slice(0, separator), origin: value.slice(separator + 1) };
  });
}

function continuationInput(value: {
  readonly logicalSession: string;
  readonly sourceVersion: string;
  readonly target: string;
  readonly mode: string;
  readonly checkpointStart?: string;
}): ContinuationPreviewRequest {
  const checkpointStartSequence = value.checkpointStart === undefined
    ? undefined
    : Number.parseInt(value.checkpointStart, 10);
  if (checkpointStartSequence !== undefined && (!Number.isSafeInteger(checkpointStartSequence) || checkpointStartSequence < 0)) {
    throw new TypeError(`Invalid checkpoint start sequence: ${value.checkpointStart}`);
  }
  return {
    logicalSessionId: value.logicalSession,
    sourceVersionId: value.sourceVersion,
    targetPresetId: value.target,
    mode: value.mode as ContinuationMode,
    ...(checkpointStartSequence === undefined ? {} : { checkpointStartSequence }),
  };
}

function resolutionInput(value: {
  readonly logicalSession: string;
  readonly leftVersion: string;
  readonly rightVersion: string;
  readonly commonAncestor?: string;
  readonly mergeNote: string;
  readonly target: string;
  readonly mode: string;
  readonly checkpointStart?: string;
}): ResolutionContinuationRequest {
  const checkpointStartSequence = value.checkpointStart === undefined
    ? undefined
    : Number.parseInt(value.checkpointStart, 10);
  if (checkpointStartSequence !== undefined && (!Number.isSafeInteger(checkpointStartSequence) || checkpointStartSequence < 0)) {
    throw new TypeError(`Invalid checkpoint start sequence: ${value.checkpointStart}`);
  }
  return {
    logicalSessionId: value.logicalSession,
    leftVersionId: value.leftVersion,
    rightVersionId: value.rightVersion,
    ...(value.commonAncestor === undefined ? {} : { commonAncestorVersionId: value.commonAncestor }),
    mergeNote: value.mergeNote,
    targetPresetId: value.target,
    mode: value.mode as ContinuationMode,
    ...(checkpointStartSequence === undefined ? {} : { checkpointStartSequence }),
  };
}

export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const program = new Command();
  program.name("dsh-session-maint").exitOverride().configureOutput({ writeOut: stdout, writeErr: stderr });
  program.addOption(new Option("--state-root <path>").default(resolve(".dsh-session-maintenance")));

  const compositionOptions = (): CompositionOptions => ({
    stateRoot: resolve(program.opts<{ stateRoot: string }>().stateRoot),
    enableCodexNativeWrites: options.fixturePolicy === undefined,
    ...(options.fixturePolicy === undefined ? {} : { fixturePolicy: options.fixturePolicy }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  program.command("init").option("--json").action(async () => {
    const config = await initializeStateRoot(compositionOptions().stateRoot);
    output(stdout, { initialized: true, schemaVersion: config.schemaVersion });
  });

  const instance = program.command("instance");
  instance.command("add")
    .requiredOption("--id <id>")
    .requiredOption("--platform <platform>")
    .requiredOption("--root <path>")
    .requiredOption("--platform-version <version>")
    .option("--display-name <name>")
    .option("--json")
    .action(async (value: { id: string; platform: string; root: string; platformVersion: string; displayName?: string }) => {
      if (value.platform !== "codex" && value.platform !== "dsh") throw new TypeError(`Invalid platform: ${value.platform}`);
      const added = await probeAndAddInstance(compositionOptions(), {
        id: value.id,
        platform: value.platform as PlatformKind,
        displayName: value.displayName ?? value.id,
        root: value.root,
        platformVersion: value.platformVersion,
      });
      output(stdout, { instance: added });
    });
  instance.command("list").option("--json").action(async () => {
    output(stdout, { instances: registeredInstances(await loadConfig(compositionOptions().stateRoot)) });
  });

  const target = program.command("codex-target");
  target.command("add")
    .requiredOption("--id <id>")
    .requiredOption("--codex-instance <id>")
    .requiredOption("--cwd <path>")
    .option("--workspace-root <path>", "allowed runtime workspace root; repeatable", collect, [])
    .requiredOption("--context-window <tokens>")
    .option("--input-budget-ratio <ratio>", "maximum handoff share of the context window", "0.2")
    .option("--model <model>")
    .option("--permissions <mode>")
    .option("--command <path>")
    .option("--json")
    .action(async (value: {
      id: string;
      codexInstance: string;
      cwd: string;
      workspaceRoot: readonly string[];
      contextWindow: string;
      inputBudgetRatio: string;
      model?: string;
      permissions?: string;
      command?: string;
    }) => {
      const contextWindowTokens = Number.parseInt(value.contextWindow, 10);
      const inputBudgetRatio = Number.parseFloat(value.inputBudgetRatio);
      const added = await addCodexTarget(compositionOptions().stateRoot, {
        id: value.id,
        codexInstanceId: value.codexInstance,
        cwd: value.cwd,
        runtimeWorkspaceRoots: value.workspaceRoot.length === 0 ? [value.cwd] : value.workspaceRoot,
        contextWindowTokens,
        inputBudgetRatio,
        ...(value.model === undefined ? {} : { model: value.model }),
        ...(value.permissions === undefined ? {} : { permissions: value.permissions }),
        ...(value.command === undefined ? {} : { command: value.command }),
      });
      output(stdout, { target: added });
    });
  target.command("list").option("--json").action(async () => {
    output(stdout, { targets: registeredCodexTargets(await loadConfig(compositionOptions().stateRoot)) });
  });

  program.command("scan")
    .option("--instance <id>")
    .option("--all")
    .option("--json")
    .action(async (value: { instance?: string; all?: boolean }) => {
      const engine = await createReadOnlyComposition(compositionOptions());
      try {
        const ids = value.instance === undefined ? engine.instances.map((item) => item.id) : [value.instance];
        if (!value.all && value.instance === undefined) throw new TypeError("scan requires --instance or --all");
        output(stdout, await engine.scan({ instanceIds: ids }));
      } finally { engine.close(); }
    });

  program.command("diff")
    .requiredOption("--logical-session <id>")
    .option("--source <binding>")
    .option("--target <binding>")
    .option("--json")
    .action(async (value: { logicalSession: string; source?: string; target?: string }) => {
      const engine = await createReadOnlyComposition(compositionOptions());
      try {
        output(stdout, await engine.diff({
          logicalSessionId: value.logicalSession,
          ...(value.source === undefined ? {} : { sourceBindingId: value.source }),
          ...(value.target === undefined ? {} : { targetBindingId: value.target }),
        }));
      } finally { engine.close(); }
    });

  program.command("plan")
    .requiredOption("--logical-session <id>")
    .requiredOption("--source <binding>")
    .option("--target <binding>")
    .option("--json")
    .action(async (value: { logicalSession: string; source: string; target?: string }) => {
      const engine = await createReadOnlyComposition(compositionOptions());
      try {
        output(stdout, { plan: await engine.createPlan({
          logicalSessionId: value.logicalSession,
          sourceBindingId: value.source,
          ...(value.target === undefined ? {} : { targetBindingId: value.target }),
          createdAt: options.clock?.() ?? new Date().toISOString(),
        }) });
      } finally { engine.close(); }
    });

  program.command("status").option("--json").action(async () => {
    const engine = await createReadOnlyComposition(compositionOptions());
    try { output(stdout, { status: await engine.status() }); } finally { engine.close(); }
  });

  const canonical = program.command("canonical");
  canonical.command("reseed-alpha2")
    .requiredOption("--candidate-file <name>")
    .requiredOption("--dsh-home <path>")
    .option("--dsh-instance-id <id>", "stable source identity", "dsh-alpha2")
    .requiredOption("--retain-dsh <id>", "DSH session to retain; repeatable", collect, [])
    .option("--maintenance-project <name>", "project for retained DSH sessions", "DeepSeek")
    .requiredOption("--maintenance-project-root <path>")
    .option("--codex-instance <id>")
    .option("--expected-codex <count>")
    .option("--json")
    .action(async (value: {
      candidateFile: string;
      dshHome: string;
      dshInstanceId: string;
      retainDsh: readonly string[];
      maintenanceProject: string;
      maintenanceProjectRoot: string;
      codexInstance?: string;
      expectedCodex?: string;
    }) => {
      const config = await loadConfig(compositionOptions().stateRoot);
      const instances = registeredInstances(config);
      const codex = value.codexInstance === undefined
        ? instances.filter((item) => item.platform === "codex")
        : instances.filter((item) => item.platform === "codex" && item.id === value.codexInstance);
      if (codex.length !== 1) {
        throw new TypeError(`Canonical reseed requires exactly one selected Codex instance; found ${codex.length}`);
      }
      const expectedCodexSessions = value.expectedCodex === undefined
        ? undefined
        : Number.parseInt(value.expectedCodex, 10);
      if (expectedCodexSessions !== undefined && (!Number.isSafeInteger(expectedCodexSessions) || expectedCodexSessions < 0)) {
        throw new TypeError(`Invalid expected Codex session count: ${value.expectedCodex}`);
      }
      const manifest = await reseedCanonicalCandidate({
        stateRoot: compositionOptions().stateRoot,
        candidateFile: value.candidateFile,
        dshHome: resolve(value.dshHome),
        dshInstanceId: value.dshInstanceId,
        retainedDshSessionIds: value.retainDsh,
        maintenanceProjectName: value.maintenanceProject,
        maintenanceProjectRoot: resolve(value.maintenanceProjectRoot),
        codexInstance: codex[0]!,
        ...(expectedCodexSessions === undefined ? {} : { expectedCodexSessions }),
        onStatus: (status) => output(stderr, status),
      });
      output(stdout, { manifest });
    });

  const continuation = program.command("continuation");
  const addContinuationOptions = (command: Command): Command => command
    .requiredOption("--logical-session <id>")
    .requiredOption("--source-version <id>")
    .requiredOption("--target <preset-id>")
    .addOption(new Option("--mode <mode>").choices(["full", "checkpoint", "structured-summary"]).makeOptionMandatory())
    .option("--checkpoint-start <sequence>")
    .option("--json");
  addContinuationOptions(continuation.command("preview")).action(async (value: {
    logicalSession: string;
    sourceVersion: string;
    target: string;
    mode: string;
    checkpointStart?: string;
  }) => {
    const engine = await createReadOnlyComposition(compositionOptions());
    try { output(stdout, { preview: await engine.previewContinuation(continuationInput(value)) }); } finally { engine.close(); }
  });
  addContinuationOptions(continuation.command("create")).action(async (value: {
    logicalSession: string;
    sourceVersion: string;
    target: string;
    mode: string;
    checkpointStart?: string;
  }) => {
    const engine = await createReadOnlyComposition(compositionOptions());
    try { output(stdout, { continuation: await engine.createContinuation(continuationInput(value)) }); } finally { engine.close(); }
  });
  const addResolutionOptions = (command: Command): Command => command
    .requiredOption("--logical-session <id>")
    .requiredOption("--left-version <id>")
    .requiredOption("--right-version <id>")
    .option("--common-ancestor <id>")
    .requiredOption("--merge-note <text>")
    .requiredOption("--target <preset-id>")
    .addOption(new Option("--mode <mode>").choices(["full", "checkpoint", "structured-summary"]).makeOptionMandatory())
    .option("--checkpoint-start <sequence>")
    .option("--json");
  addResolutionOptions(continuation.command("resolution-preview")).action(async (value: {
    logicalSession: string;
    leftVersion: string;
    rightVersion: string;
    commonAncestor?: string;
    mergeNote: string;
    target: string;
    mode: string;
    checkpointStart?: string;
  }) => {
    const engine = await createReadOnlyComposition(compositionOptions());
    try { output(stdout, { preview: await engine.previewResolutionContinuation(resolutionInput(value)) }); } finally { engine.close(); }
  });
  addResolutionOptions(continuation.command("resolution-create")).action(async (value: {
    logicalSession: string;
    leftVersion: string;
    rightVersion: string;
    commonAncestor?: string;
    mergeNote: string;
    target: string;
    mode: string;
    checkpointStart?: string;
  }) => {
    const engine = await createReadOnlyComposition(compositionOptions());
    try { output(stdout, { continuation: await engine.createResolutionContinuation(resolutionInput(value)) }); } finally { engine.close(); }
  });
  continuation.command("status").requiredOption("--id <id>").option("--json").action(async (value: { id: string }) => {
    const engine = await createReadOnlyComposition(compositionOptions());
    try {
      const job = await engine.getContinuation(value.id);
      if (job === undefined) throw new SessionMaintenanceError("CONTINUATION_NOT_FOUND", `Continuation not found: ${value.id}`);
      output(stdout, { continuation: job });
    } finally { engine.close(); }
  });
  continuation.command("recover").requiredOption("--id <id>").option("--json").action(async (value: { id: string }) => {
    const engine = await createReadOnlyComposition(compositionOptions());
    try { output(stdout, { continuation: await engine.recoverContinuation(value.id) }); } finally { engine.close(); }
  });

  program.command("serve")
    .option("--host <host>", "loopback host", "127.0.0.1")
    .option("--port <port>", "TCP port", "0")
    .option("--dsh-gateway <instance=origin>", "trusted rc.2 DSH Core endpoint; repeatable", collect, [])
    .option("--dashboard-root <path>", "trusted built Dashboard directory")
    .option("--json")
    .action(async (value: { host: string; port: string; dshGateway: readonly string[]; dashboardRoot?: string }) => {
      const port = Number.parseInt(value.port, 10);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError(`Invalid port: ${value.port}`);
      const targets = gatewayTargets(value.dshGateway);
      const engine = targets.length === 0
        ? await createReadOnlyComposition(compositionOptions())
        : await createDshWritableComposition({ ...compositionOptions(), dshGatewayTargets: targets });
      const server = await startMaintenanceServer({
        engine,
        stateRoot: compositionOptions().stateRoot,
        host: value.host,
        port,
        ...(value.dashboardRoot === undefined ? {} : { dashboardRoot: resolve(value.dashboardRoot) }),
      });
      output(stdout, { origin: server.origin, connectionFile: "connection.json" });
      await new Promise<void>((resolveSignal) => {
        process.once("SIGINT", resolveSignal);
        process.once("SIGTERM", resolveSignal);
      });
      await server.close();
      engine.close();
    });

  const unsupported = (kind: string) => async () => {
    throw new SessionMaintenanceError("CAPABILITY_NOT_AVAILABLE", `${kind} is unavailable in phase one`);
  };
  program.command("apply").requiredOption("--plan <id>").option("--json").action(unsupported("apply"));
  program.command("restore").requiredOption("--transaction <id>").option("--json").action(unsupported("restore"));

  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    const code = error instanceof SessionMaintenanceError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof Error ? error.message : "Unknown error";
    output(stderr, { code, message } as JsonValue);
    return code === "CAPABILITY_NOT_AVAILABLE" ? 2 : 1;
  }
}
