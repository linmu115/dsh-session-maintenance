import { describe, expect, it } from "vitest";
import { instanceWorkspacePolicyUpdateSchema, instanceWorkspacePolicySchema, instanceSessionAvailabilitySchema } from "../src/index.js";

describe("instance workspace scope contracts", () => {
  it("distinguishes all, explicit empty, and unassigned-only without inventing a profile or Vault policy", () => {
    for (const selection of [{ kind: "all" }, { kind: "ids", workspaceIds: [], includeUnassigned: false }, { kind: "ids", workspaceIds: [], includeUnassigned: true }])
      expect(instanceWorkspacePolicyUpdateSchema.parse({ expectedRevision: 0, selection }).selection).toEqual(selection);
    expect(instanceWorkspacePolicySchema.parse({ schemaVersion: 1, instanceId: "i-fixture", revision: 0, selection: { kind: "all" }, updatedAt: null }).updatedAt).toBeNull();
    expect(() => instanceWorkspacePolicyUpdateSchema.parse({ expectedRevision: 0, selection: { kind: "all" }, profileId: "web" })).toThrow();
  });
  it("rejects dirty identities, duplicates, ambiguous selection shapes and stale-revision coercion", () => {
    for (const ids of [["workspace", "workspace"], [" workspace"], ["space\n"], [""]])
      expect(() => instanceWorkspacePolicyUpdateSchema.parse({ expectedRevision: 0, selection: { kind: "ids", workspaceIds: ids, includeUnassigned: false } })).toThrow();
    for (const selection of [{ kind: "all", workspaceIds: [] }, { kind: "ids", workspaceIds: [] }])
      expect(() => instanceWorkspacePolicyUpdateSchema.parse({ expectedRevision: 0, selection })).toThrow();
    expect(() => instanceWorkspacePolicyUpdateSchema.parse({ expectedRevision: "0", selection: { kind: "all" } })).toThrow();
  });
  it("requires a verified native mapping for available sessions while retaining distinct unavailable states", () => {
    const base = { schemaVersion: 1, instanceId: "i-fixture", profileId: "web", logicalSessionId: "logical", workspaceId: null, policyRevision: 2, nativeSessionId: null };
    for (const status of ["not-synced", "offline", "mapping-pending", "deleted", "not-found"])
      expect(instanceSessionAvailabilitySchema.parse({ ...base, status }).status).toBe(status);
    expect(() => instanceSessionAvailabilitySchema.parse({ ...base, status: "available" })).toThrow();
    expect(instanceSessionAvailabilitySchema.parse({ ...base, status: "available", nativeSessionId: "native" }).nativeSessionId).toBe("native");
  });
});
