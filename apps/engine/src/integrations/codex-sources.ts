import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CODEX_SUPPORTED_VERSION } from "@linmu/dsh-adapter-codex-read";
import type { RegisteredInstance } from "@linmu/dsh-session-contracts";
import { addInstance, loadConfig, registeredInstances } from "../config.js";
import { IntegrationError } from "./bindings.js";

function pathIdentity(path: string): string { return process.platform === "win32" ? path.toLowerCase() : path; }

async function sourceIdentity(instance: RegisteredInstance): Promise<string> {
  return pathIdentity(await realpath(instance.root).catch(() => resolve(instance.root)));
}

/** The home is supplied by the Engine environment, never by an HTTP request. */
export async function withDefaultCodexSource(instances: readonly RegisteredInstance[], home: string | undefined): Promise<readonly RegisteredInstance[]> {
  if (home === undefined) return instances;
  const root = await realpath(home).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (root === undefined || !(await stat(root)).isDirectory()) return instances;
  const identity = pathIdentity(root);
  for (const instance of instances) {
    if (instance.platform === "codex" && await sourceIdentity(instance) === identity) return instances;
  }
  return [...instances, {
    id: `codex-default-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`,
    platform: "codex", displayName: "本机 Codex", root,
    // This selects the adapter's read-format contract; it is not a desktop version claim.
    platformVersion: CODEX_SUPPORTED_VERSION,
  }];
}

/** Caller holds the Engine writer scope. Registration changes only Maintenance configuration. */
export async function registerCodexSource(input: {
  readonly stateRoot: string;
  readonly source: RegisteredInstance;
  readonly probe: (source: RegisteredInstance) => Promise<void>;
  readonly remember: (source: RegisteredInstance) => void;
}): Promise<void> {
  const identity = pathIdentity(input.source.root);
  const configured = registeredInstances(await loadConfig(input.stateRoot));
  const selected = configured.find(existing => existing.id === input.source.id);
  if (selected !== undefined) {
    if (selected.platform !== "codex" || await sourceIdentity(selected) !== identity || selected.platformVersion !== input.source.platformVersion) {
      throw new IntegrationError("INTEGRATION_TARGET_CHANGED", "此 Codex 来源的登记发生变化，请刷新后重新接入。");
    }
    input.remember(selected);
    return;
  }
  for (const existing of configured) {
    if (existing.platform === "codex" && await sourceIdentity(existing) === identity) {
      throw new IntegrationError("INTEGRATION_TARGET_CHANGED", "此 Codex 来源的登记发生变化，请刷新后重新接入。");
    }
  }
  const registered = await addInstance(input.stateRoot, input.source, async resolved => {
    if (pathIdentity(resolved.root) !== identity) throw new IntegrationError("INTEGRATION_TARGET_CHANGED", "Codex 来源路径发生变化，未保存接入。");
    await input.probe(resolved);
  });
  input.remember(registered);
}
