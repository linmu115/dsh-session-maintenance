import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import { CodexContinuationAdapter } from "../../../packages/adapter-codex-continuation/src/index.js";
import { ScriptedAppServerTransport } from "../../../packages/adapter-codex-continuation/src/testing.js";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";

import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

function mcpPeer(child: ChildProcessWithoutNullStreams) {
  let sequence = 0;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as { readonly id?: number } & Record<string, unknown>;
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return {
    request(method: string, params: unknown): Promise<Record<string, unknown>> {
      const id = ++sequence;
      const response = new Promise<Record<string, unknown>>((resolveResponse) => pending.set(id, resolveResponse));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    close(): void {
      lines.close();
      child.stdin.end();
      child.kill();
    },
  };
}

describe("continuation HTTP and Codex MCP entries", () => {
  it("shares one idempotent job and one business error contract", async () => {
    const transport = new ScriptedAppServerTransport({
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
            id: "019-entry-contract",
            cwd: "D:\\fixture\\workspace",
            ephemeral: false,
            historyMode: "paginated",
            turns: [{ id: "turn-entry-contract", status: "completed" }],
          },
        },
        "turn/start": { turn: { id: "turn-entry-contract", status: "inProgress" } },
        "thread/read": {
          thread: {
            id: "019-entry-contract",
            cwd: "D:\\fixture\\workspace",
            ephemeral: false,
            historyMode: "paginated",
            turns: [{ id: "turn-entry-contract", status: "completed" }],
          },
        },
      },
      notifications: {
        "turn/completed": [{
          threadId: "019-entry-contract",
          turn: { id: "turn-entry-contract", status: "completed" },
        }],
      },
    });
    const fixture = await createEngineFixture("continuation-entries", {
      continuationAdapter: new CodexContinuationAdapter(() => transport),
      withContinuationTarget: true,
    });
    cleanups.push(fixture.cleanupAll);
    await fixture.engine.scan({ instanceIds: ["dsh-fixture"] });
    const session = (await fixture.engine.listSessions({ platform: "dsh" })).items[0]!;
    const version = (await fixture.engine.getGraph(session.logicalSessionId)).nodes[0]!;
    const input = {
      logicalSessionId: session.logicalSessionId,
      sourceVersionId: version.id,
      targetPresetId: "codex-default",
      mode: "full" as const,
    };
    const server = await fixture.startServer();
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    await expect(client.previewContinuation(input)).resolves.toMatchObject({ allowed: true });
    const httpJob = await client.createContinuation(input);

    const child = spawn(process.execPath, [resolve(
      import.meta.dirname,
      "../../../plugins/codex-session-maintenance/mcp/server.mjs",
    )], {
      env: {
        ...process.env,
        DSH_SESSION_MAINTENANCE_ORIGIN: server.origin,
        DSH_SESSION_MAINTENANCE_TOKEN: server.token,
      },
      stdio: "pipe",
      windowsHide: true,
    });
    const peer = mcpPeer(child);
    cleanups.push(async () => { peer.close(); });
    await expect(peer.request("initialize", { protocolVersion: "2025-06-18" })).resolves.toMatchObject({
      result: { serverInfo: { name: "dsh-session-maintenance" } },
    });
    const listed = await peer.request("tools/list", {});
    expect(JSON.stringify(listed)).toContain("continuation_create");

    const created = await peer.request("tools/call", { name: "continuation_create", arguments: input });
    const createdText = ((created.result as { content: readonly { text: string }[] }).content[0]!).text;
    expect(JSON.parse(createdText)).toMatchObject({ continuation: { id: httpJob.id } });
    expect(transport.requestedMethods().filter((method) => method === "thread/start")).toHaveLength(1);

    const invalid = { ...input, targetPresetId: "missing-target" };
    const httpErrorResponse = await fetch(`${server.origin}/v1/continuations/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify(invalid),
    });
    const httpError = await httpErrorResponse.json() as { readonly error: { readonly code: string } };
    const mcpError = await peer.request("tools/call", { name: "continuation_preview", arguments: invalid });
    expect(mcpError.result).toMatchObject({ isError: true });
    const mcpErrorText = ((mcpError.result as { content: readonly { text: string }[] }).content[0]!).text;
    expect(mcpErrorText.startsWith(`${httpError.error.code}:`)).toBe(true);
  });
});
