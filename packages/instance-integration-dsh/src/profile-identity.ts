/**
 * The identity an instance declares for Maintenance, read from its own profile patch.
 *
 * A DSH profile has two different names, and they are not interchangeable:
 *
 *   * the **profile directory** (`profiles/web`) — a filesystem fact, and the name the
 *     host side uses: the attestation receipt, the override scope and the Launcher catalog
 *     all speak it;
 *   * the **Maintenance identity** — what the instance's own plugin publishes in its lease
 *     and sends when it asks to join a workspace. It comes from the profile patch row
 *     `id: session-maintenance`, and on a real machine it is deliberately not the directory
 *     name (`web-i27c4` in `profiles/web/cordis.patch.yml`), because one directory can be
 *     copied or reused while the identity must stay unique per instance.
 *
 * The Engine matches instances by the Maintenance identity: `POST /v1/instances/workspace-joins`
 * and the takeover lease both compare `(instanceId, profileId)` against what the plugin sent.
 * Registering the directory name therefore produces an instance the plugin can never match —
 * which is exactly the defect this module exists to close.
 *
 * The placeholder rule mirrors `plugins/dsh-session-maintenance/src/instance-identity.ts`:
 * the schema defaults `dsh-web` / `web` mean "this machine declared nothing". A profile that
 * declares nothing keeps its directory name as its identity, because the engine must still be
 * able to *show* it; only registration requires a real declaration.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";

/** The schema default that means "no instance id was declared". Mirrors the plugin. */
export const PLACEHOLDER_INSTANCE_ID = "dsh-web";
/** The schema default that means "no profile id was declared". Mirrors the plugin. */
export const PLACEHOLDER_PROFILE_ID = "web";
/** The row an operator edits to declare the identity. */
export const IDENTITY_PATCH_ROW_ID = "session-maintenance";

export interface DeclaredProfileIdentity {
  /** The declared instance id, or the empty string when nothing was declared. */
  readonly instanceId: string;
  /** The declared profile id, or the empty string when nothing was declared. */
  readonly profileId: string;
  /** False when either half is missing, empty or still a placeholder. */
  readonly declared: boolean;
}

const UNDECLARED: DeclaredProfileIdentity = { instanceId: "", profileId: "", declared: false };

const isDeclared = (value: string, placeholder: string): boolean => value.length > 0 && value !== placeholder;

/**
 * Read the declaration out of an already-parsed patch layer.
 *
 * Pure on purpose: the discovery loop has the parsed profile patch in hand, so it never has to
 * read the file twice, and the rule can be tested without touching a filesystem.
 */
export function declaredIdentityFromPatch(layer: unknown): DeclaredProfileIdentity {
  const found = findMaintenanceConfig(layer, 0);
  if (found === null) return UNDECLARED;
  const instanceId = typeof found.dshInstanceId === "string" ? found.dshInstanceId.trim() : "";
  const profileId = typeof found.profileId === "string" ? found.profileId.trim() : "";
  if (!isDeclared(instanceId, PLACEHOLDER_INSTANCE_ID) || !isDeclared(profileId, PLACEHOLDER_PROFILE_ID)) return UNDECLARED;
  return { instanceId, profileId, declared: true };
}

/** The `config` of the `id: session-maintenance` row, wherever the patch nests it. */
function findMaintenanceConfig(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findMaintenanceConfig(item, depth + 1); if (found !== null) return found; }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as { id?: unknown; name?: unknown; config?: unknown };
  const isMaintenance = record.id === IDENTITY_PATCH_ROW_ID || record.name === "dsh-session-maintenance";
  if (isMaintenance && typeof record.config === "object" && record.config !== null && !Array.isArray(record.config))
    return record.config as Record<string, unknown>;
  for (const nested of Object.values(value)) { const found = findMaintenanceConfig(nested, depth + 1); if (found !== null) return found; }
  return null;
}

/** Read and judge one profile's own patch file; a missing or unreadable patch declares nothing. */
export async function readDeclaredProfileIdentity(profileRoot: string): Promise<DeclaredProfileIdentity> {
  const text = await readFile(join(profileRoot, "cordis.patch.yml"), "utf8").catch(() => null);
  if (text === null) return UNDECLARED;
  try {
    const parsed = parseDocument(text);
    if (parsed.errors.length > 0) return UNDECLARED;
    return declaredIdentityFromPatch(parsed.toJS({ maxAliasCount: 50 }));
  } catch { return UNDECLARED; }
}

/**
 * The identity an Engine target should carry for one profile directory.
 *
 * A declared identity wins; otherwise the directory name is used, so an instance that declares
 * nothing stays visible (and fails later, with an actionable message, at registration).
 */
export function maintenanceProfileId(entryName: string, declared: DeclaredProfileIdentity): string {
  return declared.declared ? declared.profileId : entryName;
}
