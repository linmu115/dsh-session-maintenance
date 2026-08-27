import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEX_CONTINUATION_CONTRACT,
  CodexContinuationAdapter,
  type CodexContinuationTarget,
} from "../src/index.js";
import { ScriptedAppServerTransport } from "../src/testing.js";

const target: CodexContinuationTarget = {
  id: "codex-default",
  platformVersion: "0.146.0",
  cwd: "D:\\workspace",
  runtimeWorkspaceRoots: ["D:\\workspace"],
  contextWindowTokens: 120_000,
};

function successfulTransport(): ScriptedAppServerTransport {
  return new ScriptedAppServerTransport({
    version: "0.146.0",
    responses: {
      initialize: {
        userAgent: "codex-cli/0.146.0",
        codexHome: "C:\\fixture\\.codex",
        platformFamily: "windows",
        platformOs: "windows",
      },
      "thread/start": {
        thread: {
          id: "019-thread",
          cwd: "D:\\workspace",
          ephemeral: false,
          historyMode: "paginated",
        },
      },
      "turn/start": { turn: { id: "turn-1", status: "inProgress" } },
      "thread/read": {
        thread: {
          id: "019-thread",
          cwd: "D:\\workspace",
          ephemeral: false,
          historyMode: "paginated",
        },
      },
    },
    notifications: {
      "turn/completed": [{ threadId: "019-thread", turn: { id: "turn-1", status: "completed" } }],
    },
  });
}

describe("Codex continuation contract", () => {
  it("creates and verifies a persistent native Codex task through app-server v2", async () => {
    const fixture = JSON.parse(await readFile(
      resolve(import.meta.dirname, "../../../fixtures/codex/0.146.0/app-server-contract.json"),
      "utf8",
    )) as unknown;
    expect(fixture).toEqual(CODEX_CONTINUATION_CONTRACT);
    const transport = successfulTransport();
    const adapter = new CodexContinuationAdapter(() => transport);

    const probe = await adapter.probe(target);
    expect(probe.status).toBe("compatible");
    expect(probe.capabilities).toEqual(["create-thread", "start-turn", "read-thread"]);

    const created = await adapter.create({ prompt: "Continue from DSH", target });
    expect(created).toMatchObject({ threadId: "019-thread", turnId: "turn-1", status: "turn-completed" });
    await expect(adapter.verify(created, target)).resolves.toMatchObject({ ok: true, threadId: "019-thread" });
    expect(transport.requestedMethods()).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
      "thread/read",
    ]);
  });

  it("fails closed when the Codex version drifts", async () => {
    const transport = new ScriptedAppServerTransport({ version: "0.147.0", responses: {}, notifications: {} });
    const adapter = new CodexContinuationAdapter(() => transport);

    await expect(adapter.probe(target)).resolves.toMatchObject({ status: "unsupported" });
    await expect(adapter.create({ prompt: "Do not create", target })).rejects.toMatchObject({
      code: "ADAPTER_INCOMPATIBLE",
    });
    expect(transport.requestedMethods()).toEqual([]);
  });

  it("retains the native thread identity when verification fails", async () => {
    const transport = successfulTransport();
    transport.failRequest("thread/read", new Error("read unavailable"));
    const adapter = new CodexContinuationAdapter(() => transport);

    const created = await adapter.create({ prompt: "Continue from DSH", target });
    await expect(adapter.verify(created, target)).rejects.toMatchObject({
      code: "CONTINUATION_VERIFY_FAILED",
      threadId: "019-thread",
    });
  });
});
