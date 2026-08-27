import { open } from "node:fs/promises";
import { mkdir, readFile, realpath, rename } from "node:fs/promises";
import { join } from "node:path";

import type {
  CodexContinuationTarget,
  MaintenanceSettings,
  MaintenanceSettingsPatch,
  PlatformKind,
  RegisteredInstance,
} from "@linmu/dsh-session-contracts";
import { maintenanceSettingsSchema, maintenanceSettingsPatchSchema } from "@linmu/dsh-session-contracts";
import { parse, stringify } from "yaml";

export interface EngineConfig {
  readonly schemaVersion: 1;
  readonly instances: Readonly<Record<string, {
    readonly platform: PlatformKind;
    readonly displayName: string;
    readonly root: string;
    readonly platformVersion: string;
  }>>;
  readonly codexTargets: Readonly<Record<string, {
    readonly codexInstanceId: string;
    readonly cwd: string;
    readonly runtimeWorkspaceRoots: readonly string[];
    readonly contextWindowTokens: number;
    readonly inputBudgetRatio: number;
    readonly model?: string;
    readonly permissions?: string;
    readonly command?: string;
  }>>;
  readonly settings: MaintenanceSettings;
}

const DEFAULT_SETTINGS: MaintenanceSettings = {
  codexInstanceId: null,
  dshInstanceId: null,
  workspaceMappingId: null,
  syncSingleSidedTitle: true,
  syncArchive: false,
  scanScope: "current",
  backupRetention: 20,
  allowBatchSafeApply: false,
};

const EMPTY_CONFIG: EngineConfig = { schemaVersion: 1, instances: {}, codexTargets: {}, settings: DEFAULT_SETTINGS };

export function configPathFor(stateRoot: string): string {
  return join(stateRoot, "config.yaml");
}

function validateConfig(value: unknown): EngineConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid config root");
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1 || typeof root.instances !== "object" || root.instances === null || Array.isArray(root.instances)) {
    throw new TypeError("Unsupported or invalid config schema");
  }
  const instances: Record<string, EngineConfig["instances"][string]> = {};
  for (const [id, item] of Object.entries(root.instances as Record<string, unknown>)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError(`Invalid instance: ${id}`);
    const record = item as Record<string, unknown>;
    if (
      (record.platform !== "codex" && record.platform !== "dsh") ||
      typeof record.displayName !== "string" ||
      typeof record.root !== "string" ||
      typeof record.platformVersion !== "string"
    ) throw new TypeError(`Invalid instance: ${id}`);
    instances[id] = {
      platform: record.platform,
      displayName: record.displayName,
      root: record.root,
      platformVersion: record.platformVersion,
    };
  }
  const targetsValue = root.codexTargets ?? {};
  if (typeof targetsValue !== "object" || targetsValue === null || Array.isArray(targetsValue)) {
    throw new TypeError("Invalid Codex target presets");
  }
  const codexTargets: Record<string, EngineConfig["codexTargets"][string]> = {};
  for (const [id, item] of Object.entries(targetsValue as Record<string, unknown>)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError(`Invalid Codex target: ${id}`);
    const record = item as Record<string, unknown>;
    if (
      typeof record.codexInstanceId !== "string" ||
      typeof record.cwd !== "string" ||
      !Array.isArray(record.runtimeWorkspaceRoots) ||
      !record.runtimeWorkspaceRoots.every((path) => typeof path === "string") ||
      typeof record.contextWindowTokens !== "number" ||
      !Number.isSafeInteger(record.contextWindowTokens) ||
      record.contextWindowTokens <= 0 ||
      typeof record.inputBudgetRatio !== "number" ||
      record.inputBudgetRatio <= 0 ||
      record.inputBudgetRatio > 1 ||
      (record.model !== undefined && typeof record.model !== "string") ||
      (record.permissions !== undefined && typeof record.permissions !== "string") ||
      (record.command !== undefined && typeof record.command !== "string")
    ) throw new TypeError(`Invalid Codex target: ${id}`);
    codexTargets[id] = {
      codexInstanceId: record.codexInstanceId,
      cwd: record.cwd,
      runtimeWorkspaceRoots: record.runtimeWorkspaceRoots as string[],
      contextWindowTokens: record.contextWindowTokens,
      inputBudgetRatio: record.inputBudgetRatio,
      ...(record.model === undefined ? {} : { model: record.model as string }),
      ...(record.permissions === undefined ? {} : { permissions: record.permissions as string }),
      ...(record.command === undefined ? {} : { command: record.command as string }),
    };
  }
  const settings = maintenanceSettingsSchema.parse(root.settings ?? DEFAULT_SETTINGS) as MaintenanceSettings;
  return { schemaVersion: 1, instances, codexTargets, settings };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function initializeStateRoot(stateRoot: string): Promise<EngineConfig> {
  await mkdir(stateRoot, { recursive: true });
  const path = configPathFor(stateRoot);
  try {
    return await loadConfig(stateRoot);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { readonly code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
    await atomicWrite(path, stringify(EMPTY_CONFIG));
    return EMPTY_CONFIG;
  }
}

export async function loadConfig(stateRoot: string): Promise<EngineConfig> {
  return validateConfig(parse(await readFile(configPathFor(stateRoot), "utf8")) as unknown);
}

export function registeredInstances(config: EngineConfig): readonly RegisteredInstance[] {
  return Object.entries(config.instances).map(([id, instance]) => ({ id, ...instance }));
}

export function registeredCodexTargets(config: EngineConfig): readonly CodexContinuationTarget[] {
  return Object.entries(config.codexTargets).map(([id, target]) => {
    const instance = config.instances[target.codexInstanceId];
    if (instance === undefined || instance.platform !== "codex") {
      throw new TypeError(`Codex target ${id} refers to a missing Codex instance: ${target.codexInstanceId}`);
    }
    return {
      id,
      ...target,
      platformVersion: instance.platformVersion,
      codexHome: instance.root,
    };
  });
}

export async function addCodexTarget(
  stateRoot: string,
  input: {
    readonly id: string;
    readonly codexInstanceId: string;
    readonly cwd: string;
    readonly runtimeWorkspaceRoots: readonly string[];
    readonly contextWindowTokens: number;
    readonly inputBudgetRatio: number;
    readonly model?: string;
    readonly permissions?: string;
    readonly command?: string;
  },
): Promise<CodexContinuationTarget> {
  const config = await initializeStateRoot(stateRoot);
  if (config.codexTargets[input.id] !== undefined) throw new TypeError(`Codex target already exists: ${input.id}`);
  const instance = config.instances[input.codexInstanceId];
  if (instance === undefined || instance.platform !== "codex") {
    throw new TypeError(`Codex target requires a registered Codex instance: ${input.codexInstanceId}`);
  }
  if (!Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens <= 0) {
    throw new TypeError("contextWindowTokens must be a positive integer");
  }
  if (!(input.inputBudgetRatio > 0 && input.inputBudgetRatio <= 1)) {
    throw new TypeError("inputBudgetRatio must be greater than zero and at most one");
  }
  const cwd = await realpath(input.cwd);
  const runtimeWorkspaceRoots = await Promise.all(input.runtimeWorkspaceRoots.map((root) => realpath(root)));
  const target = {
    codexInstanceId: input.codexInstanceId,
    cwd,
    runtimeWorkspaceRoots,
    contextWindowTokens: input.contextWindowTokens,
    inputBudgetRatio: input.inputBudgetRatio,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
    ...(input.command === undefined ? {} : { command: input.command }),
  };
  await atomicWrite(configPathFor(stateRoot), stringify({
    schemaVersion: 1,
    instances: config.instances,
    codexTargets: { ...config.codexTargets, [input.id]: target },
    settings: config.settings,
  }));
  return {
    id: input.id,
    ...target,
    platformVersion: instance.platformVersion,
    codexHome: instance.root,
  };
}

export async function addInstance(
  stateRoot: string,
  input: RegisteredInstance,
  probe: (instance: RegisteredInstance) => Promise<void>,
): Promise<RegisteredInstance> {
  const config = await initializeStateRoot(stateRoot);
  if (config.instances[input.id] !== undefined) throw new TypeError(`Instance already exists: ${input.id}`);
  const resolved: RegisteredInstance = { ...input, root: await realpath(input.root) };
  await probe(resolved);
  const instances = { ...config.instances, [resolved.id]: {
    platform: resolved.platform,
    displayName: resolved.displayName,
    root: resolved.root,
    platformVersion: resolved.platformVersion,
  } };
  await atomicWrite(configPathFor(stateRoot), stringify({ schemaVersion: 1, instances, codexTargets: config.codexTargets, settings: config.settings }));
  return resolved;
}

export async function updateSettings(
  stateRoot: string,
  input: MaintenanceSettingsPatch,
): Promise<MaintenanceSettings> {
  const patch = maintenanceSettingsPatchSchema.parse(input) as MaintenanceSettingsPatch;
  const config = await initializeStateRoot(stateRoot);
  const next = maintenanceSettingsSchema.parse({ ...config.settings, ...patch }) as MaintenanceSettings;
  const codex = next.codexInstanceId === null ? undefined : config.instances[next.codexInstanceId];
  const dsh = next.dshInstanceId === null ? undefined : config.instances[next.dshInstanceId];
  if (next.codexInstanceId !== null && codex?.platform !== "codex") {
    throw new TypeError(`Settings Codex instance is not registered: ${next.codexInstanceId}`);
  }
  if (next.dshInstanceId !== null && dsh?.platform !== "dsh") {
    throw new TypeError(`Settings DSH instance is not registered: ${next.dshInstanceId}`);
  }
  await atomicWrite(configPathFor(stateRoot), stringify({ ...config, settings: next }));
  return next;
}
