import { SessionMaintenanceError, type RetentionInventory, type RetentionPlanItem, type RetentionPolicy, type RetentionPreviewPlan } from "@linmu/dsh-session-contracts";
import { retentionDigest } from "./retention-paths.js";

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({ schemaVersion: 1, history: "protect-all-version-bodies", finishedRunHours: 48, recoveredRunHours: 120, automaticBackupsToKeep: 3, cacheTargetBytes: 1024 ** 3, quarantineHours: 48, orphanGraceHours: 48 });

export function validateRetentionPolicy(policy: RetentionPolicy): void {
  if (policy.schemaVersion !== 1 || policy.history !== "protect-all-version-bodies") throw new TypeError("History pruning is not supported by storage governance");
  for (const value of [policy.finishedRunHours, policy.recoveredRunHours, policy.cacheTargetBytes, policy.automaticBackupsToKeep, policy.quarantineHours, policy.orphanGraceHours]) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Retention limits must be nonnegative safe integers");
  if (policy.automaticBackupsToKeep < 3 || policy.quarantineHours < 48 || policy.finishedRunHours < 48 || policy.recoveredRunHours < 120 || policy.orphanGraceHours < 48) throw new TypeError("Policy cannot weaken the first-release recovery floors");
}

/** Pure and deterministic: supplied instant, snapshots and policy are its only inputs. */
export function planRetention(inventory: RetentionInventory, policy: RetentionPolicy = DEFAULT_RETENTION_POLICY): RetentionPreviewPlan {
  validateRetentionPolicy(policy);
  const at = Date.parse(inventory.asOf); if (!Number.isFinite(at)) throw new TypeError("Invalid inventory instant");
  const blocked = inventory.blockers.length > 0;
  const items: RetentionPlanItem[] = [];
  for (const object of inventory.objects) {
    const refs = inventory.references.filter((ref)=>
      (ref.targetKind === "content-object" && ref.objectRootId === object.rootId && ref.targetId === object.objectId)
      || (ref.targetKind === "version-body" && inventory.versions.some((version)=>version.id === ref.targetId && version.objectId === object.objectId && version.objectRootId === object.rootId && (version.source === ref.source || ["cache", "wal", "runtime"].includes(ref.source)))));
    const reasons = refs.map((ref)=>ref.reason);
    if (object.mtimeMs >= at - policy.orphanGraceHours * 3600000) reasons.push("orphan-grace-window");
    const disposition = reasons.length ? "protected" : blocked ? "blocked" : "candidate";
    items.push({ id: `${object.rootId}:${object.objectId}`, kind: "content-object", rootId: object.rootId, relativePath: object.relativePath, bytes: object.bytes, disposition, reasons: [...new Set(reasons.length ? reasons : blocked ? ["incomplete-reference-coverage"] : ["unreferenced-object; preview-only"])].sort(), references: refs, executable: false });
  }
  const validBackups = inventory.resources.filter((entry)=>["backup", "candidate"].includes(entry.resource.kind) && entry.valid && !entry.resource.pinned && entry.completedAt !== null);
  const newestBackups = new Set<string>();
  for (const group of new Set(validBackups.map((entry)=>`${entry.resource.kind}:${entry.resource.group}`))) {
    const sorted = validBackups.filter((entry)=>`${entry.resource.kind}:${entry.resource.group}` === group).sort((a,b)=>Date.parse(b.completedAt!) - Date.parse(a.completedAt!) || a.resource.id.localeCompare(b.resource.id));
    for (const entry of sorted.slice(0, policy.automaticBackupsToKeep)) newestBackups.add(entry.resource.id);
  }
  let cacheBytes = inventory.resources.filter((entry)=>entry.resource.kind === "cache").reduce((sum,entry)=>sum + entry.bytes, 0);
  const evictCaches = new Set<string>();
  for (const cache of inventory.resources.filter((entry)=>entry.resource.kind === "cache" && entry.valid && entry.reasons.length === 0 && entry.resource.lastUsedAt !== null).sort((a,b)=>Date.parse(a.resource.lastUsedAt!) - Date.parse(b.resource.lastUsedAt!) || a.resource.id.localeCompare(b.resource.id))) {
    if (cacheBytes <= policy.cacheTargetBytes) break;
    if (!Number.isFinite(Date.parse(cache.resource.lastUsedAt!)) || Date.parse(cache.resource.lastUsedAt!) > at) continue;
    evictCaches.add(cache.resource.id); cacheBytes -= cache.bytes;
  }
  for (const entry of inventory.resources) {
    const { resource } = entry;
    const reasons = [...entry.reasons];
    if (!entry.valid) reasons.push("validity-unproven");
    if (resource.kind === "run") {
      const completed = entry.completedAt === null ? NaN : Date.parse(entry.completedAt);
      const hours = entry.recoveryCompleted ? policy.recoveredRunHours : policy.finishedRunHours;
      if (!Number.isFinite(completed) || completed > at) reasons.push("trusted-completion-time-unknown");
      else if (completed > at - hours * 3600000) reasons.push("finished-run-retention-window");
    } else if (resource.kind === "cache") {
      if (!evictCaches.has(resource.id)) reasons.push("cache-capacity-target-or-protection");
    } else {
      if (newestBackups.has(resource.id)) reasons.push("newest-valid-automatic-backups");
      if (!entry.completedAt || !Number.isFinite(Date.parse(entry.completedAt)) || Date.parse(entry.completedAt) > at) reasons.push("trusted-completion-time-unknown");
    }
    const disposition = reasons.length ? "protected" : blocked ? "blocked" : "candidate";
    items.push({ id: resource.id, kind: resource.kind, rootId: resource.rootId, relativePath: resource.relativePath, bytes: entry.bytes, disposition, reasons: [...new Set(reasons.length ? reasons : blocked ? ["incomplete-reference-coverage"] : ["verified-governance-eligibility"])].sort(), references: inventory.references.filter((ref)=>ref.targetKind === resource.kind && ref.targetId === resource.ownerId), executable: disposition === "candidate" });
  }
  items.sort((a,b)=>a.id.localeCompare(b.id));
  const payload = { schemaVersion: 1 as const, asOf: inventory.asOf, policy, sourceRevisions: inventory.sourceRevisions, registryFingerprint: inventory.registryFingerprint, referenceFingerprint: inventory.referenceFingerprint, objectFingerprint: inventory.objectFingerprint, resourceFingerprint: inventory.resourceFingerprint, blockers: inventory.blockers, items, protectedBytes: items.filter((item)=>item.disposition === "protected").reduce((sum,item)=>sum + item.bytes,0), candidateBytes: items.filter((item)=>item.disposition === "candidate").reduce((sum,item)=>sum + item.bytes,0), executableBytes: items.filter((item)=>item.executable).reduce((sum,item)=>sum + item.bytes,0), cacheBytesAboveTarget: Math.max(0,cacheBytes-policy.cacheTargetBytes) };
  return { ...payload, id: retentionDigest(payload) };
}

export function assertRetentionPlanCurrent(plan: RetentionPreviewPlan, inventory: RetentionInventory): void {
  const current = planRetention(inventory, plan.policy);
  if (plan.asOf !== inventory.asOf || current.id !== plan.id || retentionDigest(plan) !== retentionDigest(current)) throw new SessionMaintenanceError("PLAN_STALE", "Storage governance references, resources, policy or registered roots changed");
  if (current.blockers.length) throw new SessionMaintenanceError("RECOVERY_REQUIRED", "Storage governance is blocked by incomplete evidence");
}
