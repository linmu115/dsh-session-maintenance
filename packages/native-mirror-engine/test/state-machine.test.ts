import { describe, expect, it } from "vitest";

import type {
  NativeMirrorRecord,
  NativeMirrorRepository,
  ObservedHead,
  PlatformBinding,
  SessionRepository,
} from "@linmu/dsh-session-contracts";

import { NativeMirrorService } from "../src/index.js";

function binding(id: string, platform: "codex" | "dsh"): PlatformBinding {
  return {
    id,
    logicalSessionId: "logical",
    key: { platform, instanceId: platform, sessionId: `${platform}-session` },
    adapterContract: { adapter: `${platform}-read`, platformVersion: "fixture", schemaFingerprint: "fixture" },
    lastCommonVersionId: "base",
    status: "writable",
  };
}

describe("NativeMirrorService", () => {
  it("drives the whitelist, fast-forward, conflict and unlink states without rewriting history", async () => {
    const codex = binding("codex-binding", "codex");
    const dsh = binding("dsh-binding", "dsh");
    const heads = new Map<string, ObservedHead>([
      [codex.id, { bindingId: codex.id, versionId: "base", observedAt: "2026-08-27T00:00:00.000Z", fingerprint: { platform: "codex", instanceId: "codex", sessionId: "codex-session", kind: "content", value: "base" } }],
      [dsh.id, { bindingId: dsh.id, versionId: "base", observedAt: "2026-08-27T00:00:00.000Z", fingerprint: { platform: "dsh", instanceId: "dsh", sessionId: "dsh-session", kind: "content", value: "base" } }],
    ]);
    let mirror: NativeMirrorRecord | undefined;
    let mode = "continuation";
    let canonical = "base";
    const repository = {
      listBindings: async () => [codex, dsh],
      getObservedHead: async (id: string) => heads.get(id),
      getGraph: async () => ({ nodes: [{ id: "base", parents: [] }, { id: "codex", parents: ["base"] }, { id: "dsh", parents: ["base"] }] }),
      getNativeMirror: async () => mirror,
      listNativeMirrors: async () => mirror === undefined ? [] : [mirror],
      upsertNativeMirror: async (value: NativeMirrorRecord) => (mirror = value),
      removeNativeMirror: async () => { const existed = mirror !== undefined; mirror = undefined; return existed; },
      setLogicalSessionSyncMode: async (_id: string, value: string) => { mode = value; },
      setCanonicalVersion: async (_id: string, value: string) => { canonical = value; },
    } as unknown as SessionRepository & NativeMirrorRepository;
    let tick = 0;
    const service = new NativeMirrorService({ repository, clock: () => `2026-08-27T00:00:0${tick++}.000Z` });

    expect((await service.apply("logical", { action: "enable" })).state).toBe("active");
    expect(mode).toBe("native-mirror");
    expect((await service.apply("logical", { action: "pause", reason: "maintenance" })).state).toBe("paused");
    expect(mode).toBe("paused");
    expect((await service.apply("logical", { action: "resume" })).state).toBe("active");

    heads.set(codex.id, { ...heads.get(codex.id)!, versionId: "codex" });
    heads.set(dsh.id, { ...heads.get(dsh.id)!, versionId: "dsh" });
    expect((await service.apply("logical", { action: "resume" })).state).toBe("conflicted");
    expect((await service.apply("logical", { action: "keep-branches" })).state).toBe("conflicted");
    await service.apply("logical", { action: "choose-canonical", platform: "codex" });
    expect(canonical).toBe("codex");
    expect((await service.preview("logical", { action: "reset-target", platform: "dsh" }))).toMatchObject({ allowed: false, confirmationRequired: true });
    expect((await service.apply("logical", { action: "unlink" })).state).toBe("disabled");
    expect(mode).toBe("continuation");
    expect(await service.list()).toEqual([]);
  });
});
