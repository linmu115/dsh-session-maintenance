import { describe, expect, it } from "vitest";
import { MaintenanceClient } from "../src/index.js";

describe("checkpoint restore capability client", () => {
  it("uses an authenticated GET, escapes the checkpoint ID and forwards cancellation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const controller = new AbortController();
    const client = new MaintenanceClient({ origin: "http://127.0.0.1:1", token: "synthetic-token",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return Response.json({ capability: { checkpointId: "checkpoint/id", supported: false, reason: "当前格式不支持恢复预览。" } });
      } });
    expect(await client.getCheckpointRestoreCapability("checkpoint/id", controller.signal)).toEqual({ checkpointId: "checkpoint/id", supported: false, reason: "当前格式不支持恢复预览。" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:1/v1/checkpoints/checkpoint%2Fid/restore-capability");
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer synthetic-token");
  });

  it.each([
    { checkpointId: "checkpoint", supported: "yes", reason: "错误类型" },
    { checkpointId: "checkpoint", supported: true },
    { checkpointId: "checkpoint", supported: true, reason: "" },
    { checkpointId: "checkpoint", supported: true, reason: "ok", planId: "must-not-be-a-plan" },
  ])("rejects malformed capability responses %j", async (capability) => {
    const client = new MaintenanceClient({ origin: "http://127.0.0.1:1", token: "synthetic-token",
      fetchImpl: async () => Response.json({ capability }) });
    await expect(client.getCheckpointRestoreCapability("checkpoint")).rejects.toThrow();
  });
});
