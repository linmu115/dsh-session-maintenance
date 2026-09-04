import { describe, expect, it } from "vitest";

import { validateRuntimeShutdownBody } from "../src/runtime-shutdown.js";

describe("Maintenance runtime shutdown", () => {
  it("accepts only the active run owner and never accepts a token or path in the body", () => {
    expect(validateRuntimeShutdownBody({
      schemaVersion: 1,
      runId: "run-alpha2",
      clientId: "launcher-owner",
    }, {
      runId: "run-alpha2",
      ownerClientId: "launcher-owner",
    })).toEqual({
      schemaVersion: 1,
      runId: "run-alpha2",
      clientId: "launcher-owner",
    });
    expect(() => validateRuntimeShutdownBody({
      schemaVersion: 1,
      runId: "run-alpha2",
      clientId: "plugin-runtime",
    }, {
      runId: "run-alpha2",
      ownerClientId: "launcher-owner",
    })).toThrow(/owner/iu);
    expect(() => validateRuntimeShutdownBody({
      schemaVersion: 1,
      runId: "run-alpha2",
      clientId: "launcher-owner",
      token: "must-not-cross-the-body",
    }, {
      runId: "run-alpha2",
      ownerClientId: "launcher-owner",
    })).toThrow(/unsupported/iu);
    expect(() => validateRuntimeShutdownBody({
      schemaVersion: 1,
      runId: "D:/projection/run-alpha2",
      clientId: "launcher-owner",
    }, {
      runId: "D:/projection/run-alpha2",
      ownerClientId: "launcher-owner",
    })).toThrow(/IDs/iu);
  });
});
