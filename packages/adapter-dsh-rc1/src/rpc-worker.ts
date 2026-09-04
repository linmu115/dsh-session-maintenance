import { createInterface } from "node:readline";

import type { DshEnvironmentDescriptor, JsonValue } from "@linmu/dsh-session-adapter-sdk";

import { adapter } from "./index.js";

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly payload: JsonValue;
}

function isRequest(value: unknown): value is RpcRequest {
  return typeof value === "object" && value !== null
    && Number.isSafeInteger((value as { readonly id?: unknown }).id)
    && typeof (value as { readonly method?: unknown }).method === "string"
    && "payload" in value;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void (async () => {
    let id: number | null = null;
    try {
      const request = JSON.parse(line) as unknown;
      if (!isRequest(request)) throw new TypeError("Invalid Adapter RPC request");
      id = request.id;
      if (request.method !== "probe") throw new Error(`Unsupported Adapter RPC method: ${request.method}`);
      const result = await adapter.probe(request.payload as unknown as DshEnvironmentDescriptor);
      process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: "ADAPTER_RPC_FAILED" } })}\n`);
    }
  })();
});
