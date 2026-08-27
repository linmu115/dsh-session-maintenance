import { describe, expect, it } from "vitest";

import { CodexContinuationAdapter } from "../../packages/adapter-codex-continuation/src/index.js";
import { ScriptedAppServerTransport } from "../../packages/adapter-codex-continuation/src/testing.js";
import { ContinuationService } from "../../packages/continuation-engine/src/index.js";

import { createReadOnlyTestSystem } from "./helpers/read-only-system.js";

describe("phase 3 continuation", () => {
  it("creates, verifies, binds and deduplicates a native Codex continuation", async () => {
    const system = await createReadOnlyTestSystem();
    try {
      await system.discovery.scanInstance("dsh-fixture");
      const sessions = await system.repository.listSessions({ platform: "dsh" });
      const logicalSessionId = sessions.items[0]!.logicalSessionId;
      const graph = await system.repository.getGraphPage(logicalSessionId);
      const sourceVersionId = graph.nodes[0]!.id;
      const transport = new ScriptedAppServerTransport({
        version: "0.146.0",
        responses: {
          initialize: {
            userAgent: "codex-cli/0.146.0",
            codexHome: system.sandbox.codexHome,
            platformFamily: "windows",
            platformOs: "windows",
          },
          "thread/start": {
            thread: {
              id: "019-continuation",
              cwd: "D:\\fixture\\workspace",
              ephemeral: false,
              historyMode: "paginated",
              turns: [{ id: "turn-continuation", status: "completed" }],
            },
          },
          "turn/start": { turn: { id: "turn-continuation", status: "inProgress" } },
          "thread/read": {
            thread: {
              id: "019-continuation",
              cwd: "D:\\fixture\\workspace",
              ephemeral: false,
              historyMode: "paginated",
              turns: [{ id: "turn-continuation", status: "completed" }],
            },
          },
        },
        notifications: {
          "turn/completed": [{
            threadId: "019-continuation",
            turn: { id: "turn-continuation", status: "completed" },
          }],
        },
      });
      const service = new ContinuationService({
        repository: system.repository,
        objectStore: system.repository.objectStore,
        adapter: new CodexContinuationAdapter(() => transport),
        targets: [{
          id: "codex-default",
          codexInstanceId: "codex-fixture",
          platformVersion: "0.146.0",
          codexHome: system.sandbox.codexHome,
          cwd: "D:\\fixture\\workspace",
          runtimeWorkspaceRoots: ["D:\\fixture\\workspace"],
          contextWindowTokens: 120_000,
          inputBudgetRatio: 0.8,
        }],
        clock: () => "2026-08-27T03:00:00.000Z",
      });
      const request = {
        logicalSessionId,
        sourceVersionId,
        targetPresetId: "codex-default",
        mode: "full" as const,
      };

      const preview = await service.preview(request);
      expect(preview.allowed).toBe(true);
      transport.failRequest("thread/read", new Error("injected verification outage"));
      const interrupted = await service.create(request);
      expect(interrupted).toMatchObject({ status: "manual-review", codexThreadId: "019-continuation" });

      transport.clearRequestFailure("thread/read");
      const restartedService = new ContinuationService({
        repository: system.repository,
        objectStore: system.repository.objectStore,
        adapter: new CodexContinuationAdapter(() => transport),
        targets: [{
          id: "codex-default",
          codexInstanceId: "codex-fixture",
          platformVersion: "0.146.0",
          codexHome: system.sandbox.codexHome,
          cwd: "D:\\fixture\\workspace",
          runtimeWorkspaceRoots: ["D:\\fixture\\workspace"],
          contextWindowTokens: 120_000,
          inputBudgetRatio: 0.8,
        }],
        clock: () => "2026-08-27T03:00:01.000Z",
      });
      const first = await restartedService.recover(interrupted.id);
      const repeated = await restartedService.create(request);

      expect(first).toMatchObject({ status: "completed", codexThreadId: "019-continuation" });
      expect(repeated.id).toBe(first.id);
      expect(transport.requestedMethods().filter((method) => method === "thread/start")).toHaveLength(1);
      await expect(system.repository.findBinding({
        platform: "codex",
        instanceId: "codex-fixture",
        sessionId: "019-continuation",
      })).resolves.toMatchObject({ logicalSessionId, lastCommonVersionId: sourceVersionId });
    } finally {
      await system.cleanup();
    }
  });
});
