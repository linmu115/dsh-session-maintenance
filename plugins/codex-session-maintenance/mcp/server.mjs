import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const continuationInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["logicalSessionId", "sourceVersionId", "targetPresetId", "mode"],
  properties: {
    logicalSessionId: { type: "string", minLength: 1 },
    sourceVersionId: { type: "string", minLength: 1 },
    targetPresetId: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["full", "checkpoint", "structured-summary"] },
    checkpointStartSequence: { type: "integer", minimum: 0 }
  }
};

const tools = [
  {
    name: "continuation_preview",
    description: "Preview the token budget, omissions, and immutable sources for a DSH-to-Codex continuation. Always call this before create.",
    inputSchema: continuationInputSchema
  },
  {
    name: "continuation_create",
    description: "Create an idempotent native Codex continuation after an allowed preview and explicit user confirmation.",
    inputSchema: continuationInputSchema
  },
  {
    name: "continuation_status",
    description: "Get the persisted status and native Codex task ID for a continuation job.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["continuationId"],
      properties: { continuationId: { type: "string", minLength: 1 } }
    }
  },
  {
    name: "logical_session_open",
    description: "Verify a continuation exists and return its stable local maintenance detail URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["continuationId"],
      properties: { continuationId: { type: "string", minLength: 1 } }
    }
  }
];

function loopbackOrigin(host, port) {
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Maintenance connection must use 127.0.0.1 and a valid port");
  }
  return `http://${host}:${port}`;
}

async function connection() {
  const directOrigin = process.env.DSH_SESSION_MAINTENANCE_ORIGIN;
  const directToken = process.env.DSH_SESSION_MAINTENANCE_TOKEN;
  if (directOrigin !== undefined || directToken !== undefined) {
    if (directOrigin === undefined || directToken === undefined) throw new Error("Both direct origin and token must be configured");
    const url = new URL(directOrigin);
    return { origin: loopbackOrigin(url.hostname, Number(url.port)), token: directToken };
  }
  const stateRoot = process.env.DSH_SESSION_MAINTENANCE_STATE_ROOT;
  if (stateRoot === undefined) throw new Error("DSH_SESSION_MAINTENANCE_STATE_ROOT is not configured");
  const parsed = JSON.parse(await readFile(resolve(stateRoot, "connection.json"), "utf8"));
  if (parsed?.schemaVersion !== 1 || typeof parsed.token !== "string") throw new Error("Invalid maintenance connection file");
  return { origin: loopbackOrigin(parsed.host, parsed.port), token: parsed.token };
}

async function request(path, init = {}) {
  const current = await connection();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${current.token}`);
  const response = await fetch(`${current.origin}${path}`, { ...init, headers });
  const value = await response.json().catch(() => ({ error: { code: "INVALID_RESPONSE", message: `HTTP ${response.status}` } }));
  if (!response.ok) {
    const code = value?.error?.code ?? "MAINTENANCE_REQUEST_FAILED";
    const message = value?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`${code}: ${String(message).replaceAll(current.token, "[REDACTED]")}`);
  }
  return { value, origin: current.origin };
}

function post(value) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

async function callTool(name, args) {
  if (name === "continuation_preview") return (await request("/v1/continuations/preview", post(args))).value;
  if (name === "continuation_create") return (await request("/v1/continuations", post(args))).value;
  if (name === "continuation_status") {
    return (await request(`/v1/continuations/${encodeURIComponent(args.continuationId)}`)).value;
  }
  if (name === "logical_session_open") {
    const result = await request(`/v1/continuations/${encodeURIComponent(args.continuationId)}`);
    return {
      continuation: result.value.continuation,
      detailUrl: `${result.origin}/v1/continuations/${encodeURIComponent(args.continuationId)}`
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dsh-session-maintenance", version: "0.1.0" }
      };
    } else if (message.method === "ping") result = {};
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "tools/call") {
      try {
        const value = await callTool(message.params?.name, message.params?.arguments ?? {});
        result = { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        result = {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Maintenance request failed" }],
          isError: true
        };
      }
    } else throw Object.assign(new Error(`Method not found: ${message.method}`), { rpcCode: -32601 });
    write({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: error?.rpcCode ?? -32000, message: error instanceof Error ? error.message : "MCP request failed" }
    });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.trim().length === 0) continue;
  try { await handle(JSON.parse(line)); }
  catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
}
