import { appendFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  RegisteredInstance,
  StableObservation,
  StableObservation as StableObservationType,
} from "@linmu/dsh-session-contracts";
import { readCanonicalConversationTopologyV1 } from "@linmu/dsh-session-contracts";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  type FixtureSandbox,
} from "@linmu/dsh-session-test-support";

import {
  CodexReadAdapter,
  codexDisplayTitle,
  readCodexCanonicalSemantics,
  type CodexReadStatusEvent,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
};

function expectStable(observation: StableObservationType | { readonly kind: "unstable" }): StableObservation {
  expect(observation.kind).toBe("stable");
  return observation as StableObservation;
}

function instance(sandbox: FixtureSandbox): RegisteredInstance {
  return {
    id: "codex-fixture",
    platform: "codex",
    displayName: "fixture",
    root: sandbox.codexHome,
    platformVersion: "0.146.0",
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CodexReadAdapter", () => {
  it("probes, lists, observes, normalizes and verifies without writes", async () => {
    const sandbox = await createFixtureSandbox("codex-read");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    expect((await adapter.probe(registered)).status).toBe("compatible");
    adapter.resetDebugCounters();
    const summaries = await collect(adapter.list(registered));
    expect(summaries).toHaveLength(1);
    expect(adapter.debugCounters().rolloutBodyReads).toBe(0);

    const observed = expectStable(
      await adapter.observe(registered, summaries[0]!.key, summaries[0]!.hint),
    );
    const normalized = await adapter.normalize(observed);
    expect(normalized.events.map((event) => event.role)).toEqual(["user", "assistant"]);
    expect(adapter.debugCounters().rolloutBodyReads).toBe(1);
    expect(
      (
        await adapter.verify(registered, summaries[0]!.key, {
          fingerprints: [observed.fingerprint],
        })
      ).ok,
    ).toBe(true);
  });

  it("lists 100 summaries without reading rollout bodies", async () => {
    const sandbox = await createFixtureSandbox("codex-catalog");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const database = new DatabaseSync(join(sandbox.codexHome, "state_5.sqlite"));
    const insert = database.prepare(
      `INSERT INTO threads
        (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
         sandbox_policy, approval_mode, cli_version, first_user_message, created_at_ms,
         updated_at_ms, preview, recency_at, recency_at_ms, name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 2; index <= 100; index += 1) {
      insert.run(
        `thread-${index}`,
        "rollouts/thread-fixture.jsonl",
        1787702400,
        1787702402,
        "vscode",
        "openai",
        "C:\\fixture\\workspace",
        `Fixture ${index}`,
        "workspace-write",
        "never",
        "0.146.0",
        `Fixture ${index}`,
        1787702400000,
        1787702402000,
        `Fixture ${index}`,
        1787702402,
        1787702402000,
        "fixture",
      );
    }
    database.close();

    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    adapter.resetDebugCounters();
    expect(await collect(adapter.list(instance(sandbox)))).toHaveLength(100);
    expect(adapter.debugCounters()).toMatchObject({ rolloutBodyReads: 0, rolloutProbeReads: 0 });
  }, 15_000);

  it("hot-reads a WAL snapshot while Codex holds an uncommitted writer", async () => {
    const sandbox = await createFixtureSandbox("codex-hot-read");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const databasePath = join(sandbox.codexHome, "state_5.sqlite");
    const setup = new DatabaseSync(databasePath);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();

    const writer = new DatabaseSync(databasePath);
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE threads SET name = ? WHERE id = ?").run("uncommitted name", "thread-fixture");
    const status: CodexReadStatusEvent[] = [];
    const adapter = new CodexReadAdapter({
      fixtureGuard: assertFixtureSandbox,
      onStatus: (event) => status.push(event),
    });

    try {
      const duringWrite = await collect(adapter.list(instance(sandbox)));
      expect(duringWrite[0]?.title).toBe("Fixture conversation");
      expect((await adapter.observe(instance(sandbox), duringWrite[0]!.key, duringWrite[0]!.hint)).kind)
        .toBe("stable");
      expect(status).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stage: "catalog.snapshot",
          state: "succeeded",
          consistency: "sqlite-read-transaction",
        }),
        expect.objectContaining({
          stage: "rollout.stability",
          state: "succeeded",
          consistency: "bounded-prefix",
        }),
      ]));
      writer.exec("COMMIT");
      expect((await collect(adapter.list(instance(sandbox))))[0]?.title).toBe("uncommitted name");
    } finally {
      try { writer.exec("ROLLBACK"); } catch { /* already committed */ }
      writer.close();
    }
  });

  it("uses the concise Codex task name and bounds polluted fallback titles", () => {
    expect(codexDisplayTitle({
      id: "01a03e27-ae05-78d2-8e31-14be2325f57b",
      name: "  查找并改造浮窗会话插件  ",
      title: "这是完整且很长的首条用户请求",
    })).toBe("查找并改造浮窗会话插件");
    expect(codexDisplayTitle({
      id: "019ffbbf-4609-7a02-9079-b55a40d4cfe8",
      name: null,
      title: "<codex_delegation><input>创建并主持一门持续交互式速学课。\n后续细节不应全部成为标题。</input></codex_delegation>",
    })).toBe("创建并主持一门持续交互式速学课。 后续细节不应全部成为标题。");
    expect(codexDisplayTitle({
      id: "01a03e2b-04ae-70a1-adee-770fe80e7876",
      name: null,
      title: "# Files mentioned by the user:\n\n## screenshot.png\n\n## My request:\n修复真实会话标题",
    })).toBe("修复真实会话标题");
    expect(codexDisplayTitle({
      id: "01a0423e-6a5c-7180-b4dd-22d0714f93bb",
      name: null,
      title: "# DSH continuation context\n\nSource session: fixture\n\nTitle: Fixture conversation\n\n# Continuation instruction",
    })).toBe("Fixture conversation");
    expect(codexDisplayTitle({
      id: "01a05ab9-bb10-7550-9c0b-8a8748feac3c",
      name: null,
      title: "",
    })).toBe("未命名会话 · 01a05ab9");
    expect(codexDisplayTitle({
      id: "019d75e8-7294-7960-8eab-835b5324b0a9",
      name: null,
      title: "设置工作树失败是什么意思\n[info] Starting worktree creation\r\nfatal: invalid reference: HEAD\r\n[stderr] git worktree add failed",
    })).toBe("设置工作树失败是什么意思");
  });

  it("excludes Guardian and spawned worker threads while retaining user-visible delegated tasks", async () => {
    const sandbox = await createFixtureSandbox("codex-visible-catalog");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const database = new DatabaseSync(join(sandbox.codexHome, "state_5.sqlite"));
    const insert = database.prepare(
      `INSERT INTO threads
        (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
         sandbox_policy, approval_mode, cli_version, first_user_message, created_at_ms,
         updated_at_ms, preview, recency_at, recency_at_ms, name, agent_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const values = (id: string, source: string, title: string, agentRole: string | null = null) => [
      id, "rollouts/thread-fixture.jsonl", 1787702400, 1787702402, source, "openai",
      "C:\\fixture\\workspace", title, "workspace-write", "never", "0.146.0", title,
      1787702400000, 1787702402000, title, 1787702402, 1787702402000, null, agentRole,
    ] as const;
    insert.run(...values(
      "guardian-thread",
      JSON.stringify({ subagent: { other: "guardian" } }),
      "The following is the Codex agent history whose request action you are assessing.",
    ));
    insert.run(...values(
      "spawned-worker",
      JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "thread-fixture" } } }),
      "内部检索工作",
      "explorer",
    ));
    insert.run(...values(
      "delegated-visible",
      "vscode",
      "<codex_delegation><input>正式委派任务</input></codex_delegation>",
    ));
    database.close();

    const status: CodexReadStatusEvent[] = [];
    const adapter = new CodexReadAdapter({
      fixtureGuard: assertFixtureSandbox,
      onStatus: (event) => status.push(event),
    });
    const summaries = await collect(adapter.list(instance(sandbox)));
    expect(summaries.map((summary) => summary.key.sessionId).sort()).toEqual([
      "delegated-visible",
      "thread-fixture",
    ]);
    expect(summaries.find((summary) => summary.key.sessionId === "delegated-visible")?.title)
      .toBe("正式委派任务");
    expect(status).toContainEqual(expect.objectContaining({
      stage: "catalog.snapshot",
      detail: expect.stringContaining("excluded 2 internal threads"),
    }));
    await expect(adapter.observe(instance(sandbox), {
      platform: "codex",
      instanceId: "codex-fixture",
      sessionId: "guardian-thread",
    })).rejects.toThrow("absent from the registered catalog");
  });

  it("normalizes Codex custom and function tools as paired tool events", async () => {
    const sandbox = await createFixtureSandbox("codex-tools");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    await appendFile(
      join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl"),
      [
        { type: "response_item", payload: { type: "custom_tool_call", id: "call-row", call_id: "call-1", name: "exec", input: "do work" } },
        { type: "response_item", payload: { type: "custom_tool_call_output", id: "result-row", call_id: "call-1", output: [{ type: "input_text", text: "done" }] } },
        { type: "response_item", payload: { type: "function_call", id: "function-row", call_id: "call-2", namespace: "collaboration", name: "send_message", arguments: "{\"target\":\"worker\"}" } },
        { type: "response_item", payload: { type: "function_call_output", id: "function-result-row", call_id: "call-2", output: "sent" } },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    const normalized = await adapter.normalize(
      expectStable(await adapter.observe(registered, summary!.key, summary!.hint)),
    );
    const tools = normalized.events.filter((event) => event.kind === "tool-import");
    expect(tools.map((event) => event.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
    expect(tools.map((event) => event.extensions.codexTool)).toEqual([
      expect.objectContaining({ phase: "call", callId: "call-1", name: "exec", arguments: "do work" }),
      expect.objectContaining({ phase: "result", callId: "call-1", outputText: "done" }),
      expect.objectContaining({ phase: "call", callId: "call-2", name: "send_message" }),
      expect.objectContaining({ phase: "result", callId: "call-2", outputText: "sent" }),
    ]);
    expect(tools.map((event) => readCodexCanonicalSemantics(event).kind)).toEqual([
      "tool-call",
      "tool-result",
      "tool-call",
      "tool-result",
    ]);
    expect(tools.map((event) => readCanonicalConversationTopologyV1(event)?.turnId))
      .toEqual(["codex-turn:1", "codex-turn:1", "codex-turn:1", "codex-turn:1"]);
    expect(normalized.compatibility.status).toBe("compatible");
  });

  it("classifies official Codex lifecycle rows as evidence and preserves explicit turn topology", async () => {
    const sandbox = await createFixtureSandbox("codex-turn-topology");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const withTurn = (turnId: string) => ({
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
    const rows = [
      { type: "session_meta", payload: { id: "thread-fixture", cwd: "C:\\fixture\\workspace" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { type: "turn_context", payload: { turn_id: "turn-a", cwd: "C:\\fixture\\workspace" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }], ...withTurn("turn-a") } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }], ...withTurn("turn-a") } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "reasoning", id: "duplicate-presentation" } } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-a", name: "exec", input: "work", ...withTurn("turn-a") } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-a", output: "done", ...withTurn("turn-a") } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }], ...withTurn("turn-a") } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } },
      { type: "turn_context", payload: { turn_id: "turn-b", cwd: "C:\\fixture\\workspace" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second" }], ...withTurn("turn-b") } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "second answer" }], ...withTurn("turn-b") } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-b" } },
      { type: "token_usage_record", payload: { input_tokens: 100, output_tokens: 20 } },
    ];
    await writeFile(
      join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    const normalized = await adapter.normalize(
      expectStable(await adapter.observe(registered, summary!.key, summary!.hint)),
    );

    expect(normalized.events.map((event) => readCodexCanonicalSemantics(event).kind)).toEqual([
      "user-message",
      "reasoning",
      "tool-call",
      "tool-result",
      "assistant-message",
      "user-message",
      "assistant-message",
    ]);
    expect(normalized.events.map((event) => readCanonicalConversationTopologyV1(event)?.turnId)).toEqual([
      "turn-a",
      "turn-a",
      "turn-a",
      "turn-a",
      "turn-a",
      "turn-b",
      "turn-b",
    ]);
    expect(normalized.events.map((event) => readCanonicalConversationTopologyV1(event)?.turnOrdinal)).toEqual([
      0, 0, 0, 0, 0, 1, 1,
    ]);
    expect(normalized.codexClassification).toMatchObject({
      sourceEnvelopeCount: 16,
      canonicalEventCount: 7,
      evidenceOnlyCount: 9,
      otherEventCount: 0,
    });
    expect(normalized.events.every((event) => event.extensions.codexEnvelope === undefined)).toBe(true);
    expect(normalized.compatibility.status).toBe("compatible");
  });

  it("preserves an output without call_id as metadata instead of inventing an orphan tool result", async () => {
    const sandbox = await createFixtureSandbox("codex-orphan-tool-output");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    await appendFile(
      join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl"),
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          id: "orphan-output-row",
          output: "<codex_delegation>internal coordination</codex_delegation>",
        },
      })}\n`,
    );
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    const normalized = await adapter.normalize(
      expectStable(await adapter.observe(registered, summary!.key, summary!.hint)),
    );

    expect(normalized.events.some((event) => event.kind === "tool-import" || event.role === "tool")).toBe(false);
    const degraded = normalized.events.find((event) =>
      (JSON.stringify(event.extensions.codexEnvelope) ?? "").includes("orphan-output-row"));
    expect(degraded).toMatchObject({ kind: "metadata", role: "unknown" });
    expect(normalized.compatibility.status).toBe("degraded");
    expect(normalized.compatibility.issues).toContainEqual(expect.objectContaining({
      code: "CODEX_EVENT_DEGRADED",
      sourceType: "codex/response_item:function_call_output",
    }));
    expect(readCodexCanonicalSemantics(degraded!)).toMatchObject({
      disposition: "other",
      otherReason: "orphan-tool-result",
    });
  });

  it("removes Codex-only goal and annotation scaffolding from projected user messages", async () => {
    const sandbox = await createFixtureSandbox("codex-internal-context");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    await appendFile(
      join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl"),
      [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: '<codex_internal_context source="goal">\n<objective>internal only</objective>\n</codex_internal_context>' }],
          },
        },
        {
          timestamp: "2026-09-02T00:00:02.500Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "<environment_context>\n<current_date>2026-09-02</current_date>\n<timezone>Asia/Shanghai</timezone>\n</environment_context>",
            }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "<recommended_plugins>\n- internal-plugin\n</recommended_plugins>\n<system-reminder>internal tools</system-reminder>\n<app-context>internal app state</app-context>",
            }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: '# Response annotations:\ninternal description\n<response-annotations>[{"text":"hidden"}]</response-annotations>\n\n## My request:\n保留这条真实请求',
            }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<codex_delegation><input>保留正式委派内容</input></codex_delegation>" }],
          },
        },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    const normalized = await adapter.normalize(
      expectStable(await adapter.observe(registered, summary!.key, summary!.hint)),
    );

    expect(normalized.events.filter((event) => event.role === "user").map((event) => event.content)).toEqual([
      "hello from fixture",
      "## My request:\n保留这条真实请求",
      "保留正式委派内容",
    ]);
    expect(JSON.stringify(normalized.events)).not.toContain("codex_internal_context");
    expect(JSON.stringify(normalized.events)).not.toContain("environment_context");
    expect(JSON.stringify(normalized.events)).not.toContain("recommended_plugins");
    expect(JSON.stringify(normalized.events)).not.toContain("system-reminder");
    expect(JSON.stringify(normalized.events)).not.toContain("app-context");
    expect(JSON.stringify(normalized.events)).not.toContain("response-annotations");
  });

  it("removes only Codex Desktop's encoded leading-space transport artifact", async () => {
    const sandbox = await createFixtureSandbox("codex-leading-space-entity");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    await appendFile(
      join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl"),
      [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "&#x20;确认，开始施工" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "保留字面实体 &#x20;、&lt;tag&gt; 和 &amp;" }],
          },
        },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    const normalized = await adapter.normalize(
      expectStable(await adapter.observe(registered, summary!.key, summary!.hint)),
    );

    expect(normalized.events.filter((event) => event.role === "user").map((event) => event.content)).toEqual([
      "hello from fixture",
      "确认，开始施工",
      "保留字面实体 &#x20;、&lt;tag&gt; 和 &amp;",
    ]);
    expect(normalized.codexClassification.transportWhitespaceNormalizedEventCount).toBe(1);
  });

  it("uses the latest Codex compacted replacement history as the active conversation", async () => {
    const sandbox = await createFixtureSandbox("codex-compacted-history");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    await appendFile(
      join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl"),
      [
        {
          type: "response_item",
          payload: {
            type: "message",
            id: "pre-compaction-noise",
            role: "user",
            content: [{ type: "input_text", text: "这段历史已经被 Codex 压缩" }],
          },
        },
        {
          timestamp: "2026-09-03T00:00:00.000Z",
          type: "compacted",
          payload: {
            window_number: 2,
            replacement_history: [
              {
                type: "message",
                id: "developer-scaffolding",
                role: "developer",
                content: [{ type: "input_text", text: "Codex-only developer instructions" }],
              },
              {
                type: "message",
                id: "retained-user",
                role: "user",
                content: [{ type: "input_text", text: "压缩后仍需保留的用户上下文" }],
              },
              {
                type: "message",
                id: "retained-assistant",
                role: "assistant",
                content: [{ type: "output_text", text: "可移植的压缩后助手上下文" }],
              },
              {
                type: "compaction",
                id: "encrypted-codex-summary",
                encrypted_content: "source-provider-only",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            id: "post-compaction-user",
            role: "user",
            content: [{ type: "input_text", text: "压缩后新增的消息" }],
          },
        },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    const normalized = await adapter.normalize(
      expectStable(await adapter.observe(registered, summary!.key, summary!.hint)),
    );

    const visible = normalized.events
      .filter((event) => event.role === "user" || event.role === "assistant")
      .map((event) => event.content);
    expect(visible).toEqual([
      "压缩后仍需保留的用户上下文",
      "可移植的压缩后助手上下文",
      "压缩后新增的消息",
    ]);
    expect(JSON.stringify(visible)).not.toContain("hello from fixture");
    expect(JSON.stringify(visible)).not.toContain("这段历史已经被 Codex 压缩");
    expect(JSON.stringify(visible)).not.toContain("Codex-only developer instructions");
    expect(normalized.events[0]).toMatchObject({ kind: "message", role: "user" });
    expect(normalized.codexClassification).toMatchObject({
      sourceEnvelopeCount: 4,
      canonicalEventCount: 3,
      evidenceOnlyCount: 1,
      otherEventCount: 0,
    });
    expect(normalized.events.some((event) => event.extensions.sourceType === "compacted")).toBe(false);
    expect(normalized.compatibility.status).toBe("compatible");
  });

  it("accepts append-only growth after capturing a bounded prefix", async () => {
    const sandbox = await createFixtureSandbox("codex-unstable");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const status: CodexReadStatusEvent[] = [];
    const adapter = new CodexReadAdapter({
      fixtureGuard: assertFixtureSandbox,
      afterRead: async (path) => appendFile(path, " \n"),
      onStatus: (event) => status.push(event),
    });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    expect((await adapter.observe(registered, summary!.key, summary!.hint)).kind).toBe("stable");
    expect(status).toContainEqual(expect.objectContaining({
      stage: "rollout.stability",
      state: "succeeded",
      consistency: "bounded-prefix",
    }));
  });

  it("returns unstable when the captured rollout is truncated", async () => {
    const sandbox = await createFixtureSandbox("codex-truncated");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const status: CodexReadStatusEvent[] = [];
    const adapter = new CodexReadAdapter({
      fixtureGuard: assertFixtureSandbox,
      afterRead: async (path) => writeFile(path, ""),
      onStatus: (event) => status.push(event),
    });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    expect((await adapter.observe(registered, summary!.key, summary!.hint)).kind).toBe("unstable");
    expect(status).toContainEqual(expect.objectContaining({
      stage: "rollout.stability",
      state: "retry",
      consistency: "bounded-prefix",
    }));
  });

  it("preserves unknown envelopes as degraded source metadata", async () => {
    const sandbox = await createFixtureSandbox("codex-degraded");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    await appendFile(
      join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-08-26T00:00:03.000Z",
        type: "response_item",
        payload: { type: "unsupported_fixture_event", name: "synthetic", arguments: "{}" },
      })}\n`,
    );
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    const normalized = await adapter.normalize(
      expectStable(await adapter.observe(registered, summary!.key, summary!.hint)),
    );

    expect(normalized.compatibility.status).toBe("degraded");
    expect(normalized.events.at(-1)).toMatchObject({ kind: "metadata", role: "unknown" });
    expect(normalized.events.some((item) => item.kind === "tool-import")).toBe(false);
  });
});
