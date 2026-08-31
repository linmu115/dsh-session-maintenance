import { createInterface } from "node:readline";
import type { DshEnvironmentDescriptor, JsonValue } from "@linmu/dsh-session-adapter-sdk";
import { adapter } from "./index.js";

interface RpcRequest { readonly id: number; readonly method: string; readonly payload: JsonValue }
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => { void (async () => {
  let id: number | null = null;
  try {
    const request = JSON.parse(line) as Partial<RpcRequest>;
    if (!Number.isSafeInteger(request.id) || request.method !== "probe" || request.payload === undefined) throw new TypeError("Invalid RC2 Adapter RPC request");
    id = request.id as number;
    const result = await adapter.probe(request.payload as unknown as DshEnvironmentDescriptor);
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  } catch { process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: "ADAPTER_RPC_FAILED" } })}\n`); }
})(); });
