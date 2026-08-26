import { describe, expect, it } from "vitest";

import {
  candidateIdFor,
  bindingIdFor,
  logicalSessionIdFor,
  versionIdFor,
} from "../src/index.js";

describe("discovery identities", () => {
  const key = { platform: "dsh" as const, instanceId: "dsh-fixture", sessionId: "session-a" };

  it("derives deterministic IDs without timestamps", () => {
    expect(logicalSessionIdFor(key)).toMatch(/^ls_[0-9a-f]{24}$/u);
    expect(bindingIdFor(key)).toMatch(/^binding_[0-9a-f]{24}$/u);
    expect(
      versionIdFor({ logicalSessionId: "ls_a", parents: [], bodyHash: "body", metadataHash: "meta" }),
    ).toMatch(/^sv_[0-9a-f]{24}$/u);
    expect(
      candidateIdFor({ leftBindingId: "binding-a", rightKey: key, reason: "same-title" }),
    ).toMatch(/^match_[0-9a-f]{24}$/u);
  });
});
