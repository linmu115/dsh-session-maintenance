import { describe, expect, it } from "vitest";

import {
  RC2_CORE_CONTRACT_OBSERVATION,
  assessRc2CoreContract,
} from "@linmu/dsh-core-extension";

import { dshWriteProbe } from "../src/index.js";

describe("DSH Core write contract", () => {
  it("exposes the Core capabilities only for the exact registered rc.2 instance", () => {
    const core = assessRc2CoreContract(RC2_CORE_CONTRACT_OBSERVATION);
    const instance = {
      id: "dsh-fixture",
      platform: "dsh" as const,
      displayName: "fixture",
      root: "C:\\synthetic-dsh",
      platformVersion: "0.1.1-rc.2",
    };
    expect(dshWriteProbe(instance, core)).toMatchObject({
      status: "compatible",
      capabilities: [
        "create-session",
        "append-events",
        "update-title",
        "update-archive",
        "verify",
        "restore",
      ],
    });
    expect(
      dshWriteProbe({ ...instance, platformVersion: "0.1.1-rc.3" }, core),
    ).toMatchObject({ status: "unsupported", capabilities: [] });
  });
});
