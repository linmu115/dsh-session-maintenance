import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEX_CANONICAL_SEMANTICS_EXTENSION,
  codexCanonicalSemantics,
} from "@linmu/dsh-adapter-codex-read";
import { readCanonicalConversationTopologyV1 } from "@linmu/dsh-session-contracts";
import { logicalSessionIdFor } from "@linmu/dsh-session-domain";
import { SqliteAdapterEvidenceStore, SqliteCanonicalRepository } from "@linmu/dsh-session-store";

import {
  canonicalCodexEvent,
  CodexCanonicalImportService,
  type CodexCanonicalImportStatusEvent,
  type CodexCanonicalProjectAssignment,
} from "../src/codex-canonical-import.js";
import { SqliteCodexProjectPort } from "../src/sqlite-codex-project-port.js";
import { createEngineFixture, hashTree } from "./helpers.js";

describe("Codex canonical hot import", () => {
  it("promotes normalized Codex tool pairs into canonical tool events", () => {
    const logicalSessionId = "ls-tool-fixture" as never;
    const base = {
      id: "event-tool",
      parentId: null,
      sequence: 0,
      kind: "tool-import" as const,
      content: "",
      attachments: [],
      source: { platform: "codex" as const, instanceId: "codex", sessionId: "thread", eventId: "row", sequence: 0 },
    };
    const call = canonicalCodexEvent(logicalSessionId, {
      ...base,
      role: "assistant",
      extensions: {
        codexTool: { phase: "call", protocol: "custom", callId: "call-1", name: "exec", arguments: "do work" },
        [CODEX_CANONICAL_SEMANTICS_EXTENSION]: codexCanonicalSemantics({
          disposition: "canonical",
          kind: "tool-call",
          role: "assistant",
          sourceKind: "codex/response_item:custom_tool_call",
          otherReason: null,
        }),
      },
    });
    const result = canonicalCodexEvent(logicalSessionId, {
      ...base,
      id: "event-result",
      sequence: 1,
      role: "tool",
      source: { ...base.source, eventId: "result", sequence: 1 },
      extensions: {
        codexTool: { phase: "result", protocol: "custom", callId: "call-1", name: "codex-tool", outputText: "done" },
        [CODEX_CANONICAL_SEMANTICS_EXTENSION]: codexCanonicalSemantics({
          disposition: "canonical",
          kind: "tool-result",
          role: "tool",
          sourceKind: "codex/response_item:custom_tool_call_output",
          otherReason: null,
        }),
      },
    });
    expect(call).toMatchObject({ kind: "tool-call", role: "assistant", content: { callId: "call-1", name: "exec", arguments: "do work" } });
    expect(result).toMatchObject({ kind: "tool-result", role: "tool", content: { callId: "call-1", outputText: "done" } });
  });

  it("places unsupported Codex semantics in MCSF other instead of a user or assistant message", () => {
    const event = canonicalCodexEvent("ls-other-fixture" as never, {
      id: "event-unsupported",
      parentId: null,
      sequence: 0,
      kind: "metadata",
      role: "unknown",
      content: "",
      attachments: [],
      source: { platform: "codex", instanceId: "codex", sessionId: "thread", eventId: "row", sequence: 0 },
      extensions: {
        [CODEX_CANONICAL_SEMANTICS_EXTENSION]: codexCanonicalSemantics({
          disposition: "other",
          kind: "other",
          role: "unknown",
          sourceKind: "codex/response_item:unsupported_fixture_event",
          otherReason: "unsupported-source-event",
        }),
        codexEnvelope: {
          type: "response_item",
          payload: { type: "unsupported_fixture_event", private: "adapter-owned" },
        },
      },
    });

    expect(event).toMatchObject({
      kind: "other",
      role: "unknown",
      content: {
        schemaVersion: 1,
        type: "other",
        reason: "unsupported-source-event",
        sourceKind: "codex/response_item:unsupported_fixture_event",
      },
    });
    expect(event.rawPayload).toBeNull();
    expect(JSON.stringify(event.content)).not.toContain("adapter-owned");
  });

  it("rejects a canonical Codex tool event without an explicit call_id", () => {
    expect(() => canonicalCodexEvent("ls-broken-tool" as never, {
      id: "event-tool",
      parentId: null,
      sequence: 0,
      kind: "tool-import",
      role: "assistant",
      content: "work",
      attachments: [],
      source: { platform: "codex", instanceId: "codex", sessionId: "thread", eventId: "row", sequence: 0 },
      extensions: {
        codexTool: { phase: "call", protocol: "custom", name: "exec", arguments: "work" },
        [CODEX_CANONICAL_SEMANTICS_EXTENSION]: codexCanonicalSemantics({
          disposition: "canonical",
          kind: "tool-call",
          role: "assistant",
          sourceKind: "codex/response_item:custom_tool_call",
          otherReason: null,
        }),
      },
    })).toThrow("explicit call_id");
  });

  it("imports directly into the canonical engine, preserves cwd and noops unchanged content", async () => {
    const fixture = await createEngineFixture("codex-canonical-import");
    await appendFile(
      join(fixture.codexHome, "rollouts", "thread-fixture.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-08-26T00:00:03.000Z",
        type: "response_item",
        payload: { type: "unsupported_fixture_event", private: "adapter-owned" },
      })}\n`,
    );
    const assignments: CodexCanonicalProjectAssignment[] = [];
    const status: CodexCanonicalImportStatusEvent[] = [];
    const canonicalRepository = new SqliteCanonicalRepository(fixture.engine.repository.database);
    const projectPort = new SqliteCodexProjectPort(canonicalRepository);
    const importer = new CodexCanonicalImportService({
      canonicalEngine: fixture.engine.canonicalEngine,
      projectPort: {
        ensureWorkspace: (input) => projectPort.ensureWorkspace(input),
        recordAssignment: async (input) => {
          assignments.push(input);
          await projectPort.recordAssignment(input);
        },
      },
      fixtureGuard: fixture.fixturePolicy,
      evidencePort: new SqliteAdapterEvidenceStore(
        fixture.engine.repository.database,
        fixture.engine.objectStore,
        { clock: () => "2026-08-26T00:00:03.000Z" },
      ),
    });
    const instance = fixture.engine.instances.find((item) => item.platform === "codex")!;
    const before = await hashTree(fixture.codexHome);

    try {
      const first = await importer.sync({ instance, onStatus: (event) => { status.push(event); } });
      const second = await importer.sync({ instance, onStatus: (event) => { status.push(event); } });
      expect(first).toMatchObject({
        scanned: 1,
        created: 1,
        advanced: 0,
        noop: 0,
        retried: 0,
        projectAssignments: { outside: 1 },
      });
      expect(second).toMatchObject({ scanned: 1, created: 0, advanced: 0, noop: 1, retried: 0 });
      expect(assignments).toHaveLength(2);
      expect(assignments[0]).toMatchObject({
        workspaceName: "workspace",
        workspacePath: "C:\\fixture\\workspace",
        project: { projectName: "Codex 项目外", kind: "outside" },
      });
      const key = { platform: "codex" as const, instanceId: instance.id, sessionId: "thread-fixture" };
      const logicalSessionId = logicalSessionIdFor(key) as never;
      expect(await fixture.engine.canonicalEngine.store.getSession(logicalSessionId)).toMatchObject({
        session: { authorityScope: "codex", originKind: "codex-mirror" },
        workspaceId: assignments[0]!.workspaceId,
      });
      expect(fixture.engine.repository.database.prepare(
        "SELECT logical_session_id, session_id FROM platform_bindings WHERE platform = 'codex'",
      ).get()).toEqual({ logical_session_id: logicalSessionId, session_id: "thread-fixture" });
      const membership = await canonicalRepository.projects.getMembership(logicalSessionId);
      expect(membership?.projectId).toMatch(/^project-/u);
      expect(await canonicalRepository.projects.getProject(membership!.projectId!)).toMatchObject({
        name: "Codex 项目外",
        sourcePlatform: "codex",
        sourceProjectId: null,
      });
      expect(await fixture.engine.canonicalEngine.store.getSession(logicalSessionId)).toMatchObject({
        workspaceId: assignments[0]!.workspaceId,
      });
      expect(status).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "catalog.snapshot", state: "succeeded" }),
        expect.objectContaining({ stage: "rollout.stability", state: "succeeded" }),
        expect.objectContaining({ stage: "codex.classification", state: "succeeded" }),
        expect.objectContaining({ stage: "codex.topology.plan", state: "succeeded" }),
        expect.objectContaining({ stage: "canonical.import", outcome: "created" }),
        expect.objectContaining({ stage: "canonical.import", outcome: "noop" }),
        expect.objectContaining({ stage: "adapter.evidence", state: "succeeded" }),
      ]));
      const imported = await fixture.engine.canonicalEngine.store.getSession(logicalSessionId);
      const importedVersion = imported?.headVersionId === null || imported?.headVersionId === undefined
        ? undefined
        : await fixture.engine.canonicalEngine.store.getVersion(imported.headVersionId);
      const other = importedVersion?.events.find((event) => event.kind === "other");
      expect(other).toMatchObject({
        role: "unknown",
        rawPayload: null,
        content: { evidenceRef: expect.stringMatching(/^evidence:sha256:/u) },
      });
      expect(JSON.stringify(other)).not.toContain("adapter-owned");
      const conversational = importedVersion?.events.filter((event) =>
        event.kind === "user-message" || event.kind === "assistant-message");
      expect(conversational).toHaveLength(2);
      expect(conversational?.map((event) => readCanonicalConversationTopologyV1(event)?.stepOrdinal))
        .toEqual([0, 0]);
      expect(conversational?.map((event) => readCanonicalConversationTopologyV1(event)?.turnId))
        .toEqual(["codex-turn:1", "codex-turn:1"]);
      expect(await hashTree(fixture.codexHome)).toBe(before);
    } finally {
      await fixture.cleanupAll();
    }
  });
});
