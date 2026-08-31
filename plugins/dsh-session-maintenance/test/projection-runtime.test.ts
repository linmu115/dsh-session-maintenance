import { describe, expect, it, vi } from "vitest";

import {
  Alpha2ProjectionPersistenceOverlay,
  normalizeProjectionRuntimeDescriptor,
  ProjectionRuntimeRegistrar,
} from "../src/projection-runtime.js";

describe("DSH projection runtime", () => {
  it("loads by runId and loopback endpoint and attaches the projected Alpha2 catalog", async () => {
    const snapshot = {
      schemaVersion: 1 as const,
      runId: "run-alpha2-projection",
      sessions: [{ nativeSessionId: "native-alpha2", payload: { header: { version: 0 }, events: [] } }],
    };
    const transport = { load: vi.fn(async () => snapshot) };
    const overlay = new Alpha2ProjectionPersistenceOverlay();
    const attach = vi.spyOn(overlay, "attach");
    const detach = vi.spyOn(overlay, "detach");
    const registrar = new ProjectionRuntimeRegistrar({
      transport,
      overlay,
      clock: () => "2026-08-31T00:00:00.000Z",
    });
    const descriptor = {
      runId: snapshot.runId,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    };
    const registration = await registrar.attach(descriptor);
    expect(transport.load).toHaveBeenCalledWith(descriptor);
    expect(attach).toHaveBeenCalledWith(snapshot);
    expect(overlay.list(registration.registrationId)).toEqual(["native-alpha2"]);
    expect(overlay.inspect(registration.registrationId, "native-alpha2")).toMatchObject({ header: { version: 0 } });
    expect(JSON.stringify(transport.load.mock.calls)).not.toMatch(/projectionRoot|sessions[/\\]/u);
    await expect(registrar.drain(registration.registrationId, snapshot.runId)).resolves.toMatchObject({ pendingOperations: 0 });
    await registrar.detach(registration.registrationId, snapshot.runId);
    expect(detach).toHaveBeenCalledWith("projection:run-alpha2-projection");
  });

  it("rejects path-shaped run IDs and non-loopback or path-bearing endpoints", () => {
    expect(() => normalizeProjectionRuntimeDescriptor({
      runId: "D:/profile/sessions",
      maintenanceEndpoint: "http://127.0.0.1:41781",
    })).toThrow("runId");
    expect(() => normalizeProjectionRuntimeDescriptor({
      runId: "run-safe",
      maintenanceEndpoint: "https://example.com/projection",
    })).toThrow("loopback");
    expect(() => normalizeProjectionRuntimeDescriptor({
      runId: "run-safe",
      maintenanceEndpoint: "http://127.0.0.1:41781/profile/sessions",
    })).toThrow("without credentials or a projection path");
  });
});
