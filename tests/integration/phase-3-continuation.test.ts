import { describe, expect, it } from "vitest";

import { CodexContinuationAdapter } from "../../packages/adapter-codex-continuation/src/index.js";
import { ScriptedAppServerTransport } from "../../packages/adapter-codex-continuation/src/testing.js";
import { ContinuationService } from "../../packages/continuation-engine/src/index.js";
import { normalizedSessionSchema, type JsonValue } from "../../packages/contracts/src/index.js";
import { canonicalJson, normalizeSession } from "../../packages/session-domain/src/index.js";

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
              turns: [],
            },
          },
          "thread/resume": {
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

      const baseBytes = await system.repository.objectStore.get(graph.nodes[0]!.bodyObject);
      const base = normalizedSessionSchema.parse(JSON.parse(Buffer.from(baseBytes).toString("utf8")));
      const createBranch = async (name: string, content: string) => {
        const session = normalizeSession({
          key: base.key,
          title: `${base.title} ${name}`,
          archived: false,
          workspaceId: base.workspaceId,
          provenance: { ...base.key, observedAt: base.provenance.observedAt, sourceVersion: name },
          compatibility: base.compatibility,
          events: [{
            sourceEventId: `branch-${name}`,
            parentSourceEventId: null,
            sequence: 0,
            kind: "message",
            role: "user",
            content,
            attachments: [],
            extensions: {},
          }],
        });
        const bodyObject = await system.repository.objectStore.put(Buffer.from(canonicalJson(session as unknown as JsonValue)));
        return system.repository.putVersion({
          logicalSessionId,
          parents: [sourceVersionId],
          bodyObject,
          bodyHash: session.bodyHash,
          metadataHash: session.metadataHash,
          source: session.provenance,
          compatibility: session.compatibility,
        });
      };
      const left = await createBranch("left", "Continue the DSH branch");
      const right = await createBranch("right", "Continue the Codex branch");
      const resolutionTransport = new ScriptedAppServerTransport({
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
              id: "019-resolution",
              cwd: "D:\\fixture\\workspace",
              ephemeral: false,
              historyMode: "paginated",
              turns: [{ id: "turn-resolution", status: "completed" }],
            },
          },
          "turn/start": { turn: { id: "turn-resolution", status: "inProgress" } },
          "thread/read": {
            thread: {
              id: "019-resolution",
              cwd: "D:\\fixture\\workspace",
              ephemeral: false,
              historyMode: "paginated",
              turns: [],
            },
          },
          "thread/resume": {
            thread: {
              id: "019-resolution",
              cwd: "D:\\fixture\\workspace",
              ephemeral: false,
              historyMode: "paginated",
              turns: [{ id: "turn-resolution", status: "completed" }],
            },
          },
        },
        notifications: {
          "turn/completed": [{ threadId: "019-resolution", turn: { id: "turn-resolution", status: "completed" } }],
        },
      });
      const resolutionService = new ContinuationService({
        repository: system.repository,
        objectStore: system.repository.objectStore,
        adapter: new CodexContinuationAdapter(() => resolutionTransport),
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
        clock: () => "2026-08-27T03:00:02.000Z",
      });
      const resolutionRequest = {
        logicalSessionId,
        leftVersionId: left.id,
        rightVersionId: right.id,
        mergeNote: "Preserve both branches and continue with the agreed implementation.",
        targetPresetId: "codex-default",
        mode: "full" as const,
      };
      await expect(resolutionService.previewResolution(resolutionRequest)).resolves.toMatchObject({
        allowed: true,
        sourceVersionIds: [left.id, right.id],
      });
      const resolutionJob = await resolutionService.createResolution(resolutionRequest);
      const repeatedResolution = await resolutionService.createResolution(resolutionRequest);
      expect(resolutionJob).toMatchObject({
        status: "completed",
        sourceVersionIds: [left.id, right.id],
        request: { commonAncestorVersionId: sourceVersionId },
      });
      expect(repeatedResolution.id).toBe(resolutionJob.id);
      const resolvedGraph = await system.repository.getGraphPage(logicalSessionId);
      const resolutionVersion = resolvedGraph.nodes.find((node) =>
        node.parents[0] === left.id && node.parents[1] === right.id
      );
      expect(resolutionVersion).toBeDefined();
      const resolutionBodyBytes = await system.repository.objectStore.get(resolutionVersion!.bodyObject);
      const resolutionBody = normalizedSessionSchema.parse(JSON.parse(Buffer.from(resolutionBodyBytes).toString("utf8")));
      expect(resolutionBody.events[0]?.extensions.sessionMaintenanceResolution).toMatchObject({
        leftVersionId: left.id,
        rightVersionId: right.id,
        commonAncestorVersionId: sourceVersionId,
        mergeNote: resolutionRequest.mergeNote,
        sourceBodyHashes: [left.bodyHash, right.bodyHash],
      });
      await expect(system.repository.findBinding({
        platform: "codex",
        instanceId: "codex-fixture",
        sessionId: "019-resolution",
      })).resolves.toMatchObject({ lastCommonVersionId: resolutionVersion!.id });
      const dshBinding = (await system.repository.listBindings(logicalSessionId)).find((binding) => binding.key.platform === "dsh")!;
      await expect(system.repository.getObservedHead(dshBinding.id)).resolves.toMatchObject({ versionId: sourceVersionId });
      expect(resolutionTransport.requestedMethods().filter((method) => method === "thread/start")).toHaveLength(1);
    } finally {
      await system.cleanup();
    }
  });
});
