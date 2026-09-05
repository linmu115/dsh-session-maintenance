import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function hasDashboardIndex(root: string): Promise<boolean> {
  try { return (await stat(join(root, "index.html"))).isFile(); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Find only the Dashboard distributed beside this Engine, independently of cwd. */
export async function resolveEngineDashboardRoot(
  configuredRoot?: string,
  moduleUrl: string = import.meta.url,
): Promise<string | undefined> {
  if (configuredRoot !== undefined) {
    const root = resolve(configuredRoot);
    if (!await hasDashboardIndex(root)) throw new TypeError(`Dashboard index.html is missing: ${root}`);
    return root;
  }
  const engineDirectory = dirname(fileURLToPath(moduleUrl));
  // Portable archive: engine/*.mjs + dashboard/. Workspace: apps/engine/{src,dist}
  // + apps/dashboard/dist. A headless Engine may intentionally omit the UI.
  for (const root of [resolve(engineDirectory, "../dashboard"), resolve(engineDirectory, "../../dashboard/dist")]) {
    if (await hasDashboardIndex(root)) return root;
  }
  return undefined;
}
