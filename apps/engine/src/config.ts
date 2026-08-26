import { open } from "node:fs/promises";
import { mkdir, readFile, realpath, rename } from "node:fs/promises";
import { join } from "node:path";

import type { PlatformKind, RegisteredInstance } from "@linmu/dsh-session-contracts";
import { parse, stringify } from "yaml";

export interface EngineConfig {
  readonly schemaVersion: 1;
  readonly instances: Readonly<Record<string, {
    readonly platform: PlatformKind;
    readonly displayName: string;
    readonly root: string;
    readonly platformVersion: string;
  }>>;
}

const EMPTY_CONFIG: EngineConfig = { schemaVersion: 1, instances: {} };

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
  return { schemaVersion: 1, instances };
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
  await atomicWrite(configPathFor(stateRoot), stringify({ schemaVersion: 1, instances }));
  return resolved;
}
