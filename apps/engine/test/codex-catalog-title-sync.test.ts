import { describe, expect, it, vi } from "vitest";

import { CodexCatalogTitleSyncService } from "../src/codex-catalog-title-sync.js";

describe("Codex catalog title sync", () => {
  it("repairs mirror titles from the cheap catalog without observing rollout bodies", async () => {
    const list = vi.fn(async function*() {
      yield {
        key: { platform: "codex", instanceId: "codex-main", sessionId: "thread-1" },
        title: "Concise task name",
        archived: false,
        workspaceId: "workspace",
        workspaceLabel: "Workspace",
        updatedAt: "2026-09-01T00:00:00.000Z",
        hint: { size: 1, mtimeNs: "1" },
      };
      yield {
        key: { platform: "codex", instanceId: "codex-main", sessionId: "thread-2" },
        title: "Another task",
        archived: false,
        workspaceId: "workspace",
        workspaceLabel: "Workspace",
        updatedAt: "2026-09-01T00:00:01.000Z",
        hint: { size: 1, mtimeNs: "1" },
      };
    });
    const retitleCodexMirror = vi.fn()
      .mockResolvedValueOnce({ outcome: "advanced" })
      .mockResolvedValueOnce(undefined);
    const service = new CodexCatalogTitleSyncService({
      instances: [{
        id: "codex-main",
        platform: "codex",
        displayName: "Codex",
        root: "C:\\codex",
        platformVersion: "0.146.0",
      }],
      adapters: [{ platform: "codex", list } as never],
      canonicalEngine: { retitleCodexMirror } as never,
      clock: () => "2026-09-01T01:00:00.000Z",
    });

    await expect(service.sync()).resolves.toEqual({ scanned: 2, advanced: 1, unchanged: 0, missing: 1 });
    expect(list).toHaveBeenCalledTimes(1);
    expect(retitleCodexMirror).toHaveBeenCalledTimes(2);
    expect(retitleCodexMirror.mock.calls[0]?.[0]).toMatchObject({
      title: "Concise task name",
      appliedAt: "2026-09-01T01:00:00.000Z",
    });
  });
});
