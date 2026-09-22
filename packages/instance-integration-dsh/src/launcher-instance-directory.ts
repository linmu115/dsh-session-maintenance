import { join } from "node:path";
import { z } from "zod";
import { instanceWorkspaceInstanceIdSchema } from "@linmu/dsh-session-contracts";
import { IntegrationError, readJsonIfPresent } from "./bindings.js";

const catalogSchema = z.object({ instances: z.array(z.object({
  id: instanceWorkspaceInstanceIdSchema,
  name: z.string().trim().min(1).max(500).refine(name => !/[\u0000-\u001f\u007f]/u.test(name)),
})) });

/** Presentation directory only: includes new/offline instances without probing profiles or attestation. */
export async function readLauncherInstanceDirectory(root: string): Promise<readonly { instanceId: string; name: string }[] | null> {
  try {
    const raw = await readJsonIfPresent(join(root, "config.json"));
    if (raw === undefined) return null;
    const catalog = catalogSchema.safeParse(raw);
    if (!catalog.success || new Set(catalog.data.instances.map(item => item.id)).size !== catalog.data.instances.length)
      throw new Error("Invalid instance identity or name");
    return catalog.data.instances.map(item => ({ instanceId: item.id, name: item.name }));
  } catch {
    throw new IntegrationError("LAUNCHER_CATALOG_INVALID", "无法读取 Launcher 实例目录，请检查 Launcher 配置后刷新。历史记录和同步配置未修改。", 503);
  }
}
