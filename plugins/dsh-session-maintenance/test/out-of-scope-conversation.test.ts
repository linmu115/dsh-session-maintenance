import { expect, it, vi } from "vitest";
import { FrozenWriteScope, ScopedSessionWriteAccess, openWriteScope, writeTargetOf } from "../src/write-access-scope.js";

/**
 * The user's requirement, from the write side: a conversation in a workspace that
 * is not one of this instance's synchronised workspaces must not reach the
 * maintenance store, **and** must still be usable in DSH — no error shown, no
 * blocked write.
 *
 * The other half lives next door: an out-of-scope session is refused at
 * registration with `SESSION_NOT_SYNCED` (see `runtime-new-workspace.test.ts`,
 * which also pins that nothing is enrolled for it). Both halves are asserted
 * because either one alone would be satisfied by a broken implementation:
 * refusing the registration is only acceptable while the conversation works.
 */

it("lets an out-of-scope session be written while the Engine is unreachable", async () => {
  // The scope is the run's frozen one: only the joined workspace is inside it.
  const scope = new FrozenWriteScope({ workspaceIds: ["workspace-joined"], includeUnassigned: false });
  // Any call into the taken-over run's own gate would reject here, so the scoped
  // gate must never reach it for this target.
  const assertWritable = vi.fn(async () => { throw new Error("维护服务未就绪"); });
  const onUndecidable = vi.fn();
  const writeAccess = new ScopedSessionWriteAccess({ scope, assertWritable, onUndecidable });

  // A session the instance created in its own workspace: outside the scope, so
  // the write is admitted and the Engine is not consulted.
  const own = writeTargetOf({ session: { id: "session-own", workspaceId: "workspace-own" } });
  expect(own).toEqual({ workspaceId: "workspace-own", logicalSessionId: "session-own" });
  expect(writeAccess.decisionFor(own)).toBe("open");
  await expect(writeAccess.assertWritable(own)).resolves.toBeUndefined();
  expect(assertWritable).not.toHaveBeenCalled();
  // No user-visible failure and no undecidable report: this write is understood
  // and allowed, not a refusal the host has to surface.
  expect(onUndecidable).not.toHaveBeenCalled();

  // A session with no workspace in a run that admitted no unassigned sessions is
  // likewise outside the scope.
  await expect(writeAccess.assertWritable(writeTargetOf({ session: { id: "session-unassigned" } }))).resolves.toBeUndefined();
  expect(assertWritable).not.toHaveBeenCalled();
});

it("keeps the refusal scoped to registration: an in-scope session stays gated by the same gate", async () => {
  const scope = new FrozenWriteScope({ workspaceIds: ["workspace-joined"], includeUnassigned: false });
  const asserted: string[] = [];
  const writeAccess = new ScopedSessionWriteAccess({ scope,
    assertWritable: async () => { asserted.push("gate"); throw new Error("草稿与未确认数据已保留"); } });
  // The joined workspace is the case the gate exists for; it is the only one held back.
  await expect(writeAccess.assertWritable(writeTargetOf({ session: { id: "s", workspaceId: "workspace-joined" } })))
    .rejects.toThrow("草稿与未确认数据已保留");
  expect(asserted).toEqual(["gate"]);
  // The out-of-scope conversation is untouched by that outage, in the same instance.
  await expect(writeAccess.assertWritable(writeTargetOf({ session: { id: "x", workspaceId: "workspace-own" } })))
    .resolves.toBeUndefined();
  expect(asserted).toEqual(["gate"]);
});

it("does not gate anything on an instance that was never taken over", async () => {
  // No run attached: every target resolves to the open scope, so a conversation
  // in any workspace keeps working with no Engine present at all.
  const writeAccess = new ScopedSessionWriteAccess({ scope: openWriteScope,
    assertWritable: async () => { throw new Error("不应被调用"); } });
  for (const payload of [{ session: { id: "a", workspaceId: "w" } }, { sessionId: "b" }, {}, null]) {
    await expect(writeAccess.assertWritable(writeTargetOf(payload))).resolves.toBeUndefined();
  }
});
