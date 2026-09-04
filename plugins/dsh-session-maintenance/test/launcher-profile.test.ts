import { describe, expect, it } from "vitest";

import { launcherProjectionProfile, normalizeConfig } from "../src/config.js";

const base = {
  connectionId: "primary",
  dshInstanceId: "alpha2-main",
  profileId: "web",
} as const;

const brokerFields = {
  ownerClientId: "launcher-client-test",
  runtimeClientId: "plugin-client-test",
  runId: "run-alpha2-test",
  temporaryPersistenceRootId: "projection:run-alpha2-test",
  dshVersion: "0.1.2-alpha.2",
} as const;

describe("Launcher Maintenance profile contract", () => {
  it("accepts the runtime-only launcher hand-off without a native session path", () => {
    const encoded = JSON.stringify({
      schemaVersion: 1,
      sessionSource: "maintenance",
      maintenanceEndpoint: "http://127.0.0.1:41780",
      adapterSelection: "auto",
      pinnedAdapterId: null,
      branchId: "main",
      ...brokerFields,
    });
    const profile = launcherProjectionProfile(base, {
      DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE: encoded,
    });

    expect(profile).toEqual(JSON.parse(encoded));
    expect(encoded).not.toContain("sessionPath");
    expect(encoded).not.toContain("DSH_HOME");
    expect(encoded).not.toContain("token");
  });

  it("keeps native profiles unchanged when Launcher sends no hand-off", () => {
    expect(launcherProjectionProfile(base, {})).toBeNull();
  });

  it("allows an explicit experimental adapter without semver hard-locking", () => {
    expect(normalizeConfig({
      ...base,
      sessionSource: "maintenance",
      maintenanceEndpoint: "http://localhost:41780",
      adapterSelection: "experimental",
    })).toMatchObject({ adapterSelection: "experimental" });
  });

  it("rejects remote endpoints, persisted paths, extra fields and incomplete pinned selection", () => {
    expect(() => launcherProjectionProfile(base, {
      DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE: JSON.stringify({
        schemaVersion: 1,
        sessionSource: "maintenance",
        maintenanceEndpoint: "https://example.com/sessions",
        adapterSelection: "auto",
        pinnedAdapterId: null,
        branchId: "main",
        ...brokerFields,
      }),
    })).toThrow("loopback");
    expect(() => launcherProjectionProfile(base, {
      DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE: JSON.stringify({
        schemaVersion: 1,
        sessionSource: "maintenance",
        maintenanceEndpoint: "http://127.0.0.1:41780",
        adapterSelection: "pinned",
        pinnedAdapterId: null,
        branchId: "main",
        ...brokerFields,
        sessionPath: "D:/forbidden/sessions",
      }),
    })).toThrow("unsupported fields");
  });
});
