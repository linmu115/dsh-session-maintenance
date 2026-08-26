import { resolve } from "node:path";

import { Command, CommanderError, Option } from "commander";
import { SessionMaintenanceError, type JsonValue, type PlatformKind } from "@linmu/dsh-session-contracts";

import { createReadOnlyComposition, probeAndAddInstance, type CompositionOptions } from "./composition-root.js";
import { initializeStateRoot, loadConfig, registeredInstances } from "./config.js";

export interface CliOptions {
  readonly fixturePolicy?: (root: string) => void;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly clock?: () => string;
}

function output(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const program = new Command();
  program.name("dsh-session-maint").exitOverride().configureOutput({ writeOut: stdout, writeErr: stderr });
  program.addOption(new Option("--state-root <path>").default(resolve(".dsh-session-maintenance")));

  const compositionOptions = (): CompositionOptions => ({
    stateRoot: resolve(program.opts<{ stateRoot: string }>().stateRoot),
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
