import { appendFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  RegisteredInstance,
  StableObservation,
  StableObservation as StableObservationType,
} from "@linmu/dsh-session-contracts";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  type FixtureSandbox,
} from "@linmu/dsh-session-test-support";

import { CodexReadAdapter, codexDisplayTitle, type CodexReadStatusEvent } from "../src/index.js";

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
    expect(normalized.compatibility.status).toBe("compatible");
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
    expect(JSON.stringify(normalized.events)).not.toContain("response-annotations");
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
