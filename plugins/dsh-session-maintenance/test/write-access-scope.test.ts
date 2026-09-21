import { expect, it, vi } from "vitest";
import { RegisteredSessionWriteAccess } from "../src/write-access.js";
import {
  FrozenWriteScope, ScopedSessionWriteAccess, openWriteScope, writeTargetOf,
} from "../src/write-access-scope.js";

/** The taken-over run's own gate, unchanged: it refuses while the Engine is unreachable. */
function engineGate(online: () => boolean) {
  const access = new RegisteredSessionWriteAccess(
    async () => { if (!online()) throw new Error("Maintenance 未就绪"); },
    async () => undefined);
  return access;
}

/** The gate the host sees: the scoped one, over the run's own gate. */
function scopedGate(input: { readonly online: () => boolean; readonly scope?: FrozenWriteScope | typeof openWriteScope }) {
  const inner = engineGate(input.online);
  const seen: string[] = [];
  return { inner, seen, access: new ScopedSessionWriteAccess({ scope: input.scope ?? openWriteScope,
    assertWritable: () => inner.assertWritable(), onUndecidable: target => seen.push(JSON.stringify(target)) }) };
}

it("never blocks a write while this instance has not been taken over", async () => {
  // No run is attached at all — the normal case for an instance started without
  // the Engine — so the gate has nothing it may hold back, even though the run
  // gate underneath would refuse.
  const { access, inner } = scopedGate({ online: () => false, scope: openWriteScope });
  await expect(access.assertWritable({ workspaceId: "workspace-any", logicalSessionId: "session-any" })).resolves.toBeUndefined();
  expect(access.decisionFor({ workspaceId: "workspace-any" })).toBe("open");
  // The instance keeps working: nothing about a missing Engine reaches the caller.
  await expect(access.assertWritable()).resolves.toBeUndefined();
  await expect(inner.assertWritable()).rejects.toThrow("已接入 Maintenance");
});

it("holds back a session inside the frozen scope while the run is not ready", async () => {
  let online = false;
  const scope = new FrozenWriteScope({ workspaceIds: ["workspace-joined"], includeUnassigned: false });
  const { access } = scopedGate({ online: () => online, scope });
  expect(access.decisionFor({ workspaceId: "workspace-joined" })).toBe("gated");
  await expect(access.assertWritable({ workspaceId: "workspace-joined" })).rejects.toThrow("草稿与未确认数据已保留");
  // Once the run is ready again the same session is admitted.
  online = true;
  await expect(access.assertWritable({ workspaceId: "workspace-joined" })).resolves.toBeUndefined();
});

it("lets a session outside the frozen scope through without consulting the Engine", async () => {
  let probes = 0;
  const inner = new RegisteredSessionWriteAccess(async () => { probes += 1; throw new Error("Maintenance 未就绪"); },
    async () => undefined);
  const scope = new FrozenWriteScope({ workspaceIds: ["workspace-joined"], includeUnassigned: false });
  const access = new ScopedSessionWriteAccess({ scope, assertWritable: () => inner.assertWritable() });
  // A workspace the operator never joined, and an explicit session that is not in
  // the run's scope, both pass without a single Engine call.
  await expect(access.assertWritable({ workspaceId: "workspace-other" })).resolves.toBeUndefined();
  await expect(access.assertWritable({ workspaceId: "workspace-other", logicalSessionId: "session-x" })).resolves.toBeUndefined();
  expect(probes).toBe(0);
  // An explicit session inside the scope is gated even when its workspace is unknown.
  await expect(access.assertWritable({ logicalSessionId: "session-in" })).resolves.toBeUndefined();
  const scoped = new ScopedSessionWriteAccess({ scope: new FrozenWriteScope({ workspaceIds: ["workspace-joined"],
    includeUnassigned: false, logicalSessionIds: ["session-in"] }), assertWritable: () => inner.assertWritable() });
  await expect(scoped.assertWritable({ logicalSessionId: "session-in" })).rejects.toThrow("已接入 Maintenance");
  // Unassigned sessions are gated only when the run actually admitted them.
  const withUnassigned = new FrozenWriteScope({ workspaceIds: [], includeUnassigned: true });
  expect(withUnassigned.decisionFor({})).toBe("gated");
  expect(scope.decisionFor({})).toBe("open");
});

it("does not retroactively relax or extend a scope that changed after the run froze", async () => {
  let online = true;
  const frozen = new FrozenWriteScope({ workspaceIds: ["workspace-a"], includeUnassigned: false });
  const { access } = scopedGate({ online: () => online, scope: frozen });
  // The run admitted workspace-a, so a later scope that drops it cannot un-gate it.
  const later = new FrozenWriteScope({ workspaceIds: ["workspace-b"], includeUnassigned: false });
  expect(access.decisionFor({ workspaceId: "workspace-a" })).toBe("gated");
  expect(later.decisionFor({ workspaceId: "workspace-a" })).toBe("open");
  // And a later scope that adds workspace-b cannot block a write this run never admitted.
  expect(access.decisionFor({ workspaceId: "workspace-b" })).toBe("open");
  online = false;
  await expect(access.assertWritable({ workspaceId: "workspace-b" })).resolves.toBeUndefined();
  await expect(access.assertWritable({ workspaceId: "workspace-a" })).rejects.toThrow();
});

it("reports an unidentifiable target instead of guessing, and gates the identified ones", async () => {
  const scope = new FrozenWriteScope({ workspaceIds: ["workspace-joined"], includeUnassigned: true });
  const { access, seen } = scopedGate({ online: () => false, scope });
  // A host payload this build cannot read leads to no gating, and says so.
  expect(writeTargetOf({ some: "other shape" })).toEqual({});
  expect(writeTargetOf(null)).toEqual({});
  await expect(access.assertWritable(writeTargetOf({ other: "shape" }))).resolves.toBeUndefined();
  // The target was reported as undecidable rather than silently treated as out of scope.
  expect(seen).toEqual([JSON.stringify({})]);
  // The shapes this build does understand are read exactly.
  expect(writeTargetOf({ workspaceId: "w", logicalSessionId: "s" })).toEqual({ workspaceId: "w", logicalSessionId: "s" });
  expect(writeTargetOf({ session: { id: "s2", workspaceId: "w2" } })).toEqual({ workspaceId: "w2", logicalSessionId: "s2" });
  expect(writeTargetOf({ sessionId: "s3" })).toEqual({ logicalSessionId: "s3" });
  await expect(access.assertWritable(writeTargetOf({ workshop: 1 }))).resolves.toBeUndefined();
  expect(vi.isMockFunction(access.assertWritable)).toBe(false);
});
