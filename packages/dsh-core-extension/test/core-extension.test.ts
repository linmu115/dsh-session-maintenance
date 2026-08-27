import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { SessionMaintenanceError } from "@linmu/dsh-session-contracts";
import { createDshCoreFixtureHost } from "@linmu/dsh-session-test-support";

import {
  LockedRc2CoreExtension,
  RC2_CORE_CONTRACT_OBSERVATION,
  type Rc2CoreContractObservation,
} from "../src/index.js";

describe("LockedRc2CoreExtension", () => {
  it("enables the exact rc.2 contract and fails closed on implementation drift", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../../fixtures/dsh/0.1.1-rc.2/core-contract/contract.json", import.meta.url),
        "utf8",
      ),
    ) as Rc2CoreContractObservation;
    expect(fixture).toEqual(RC2_CORE_CONTRACT_OBSERVATION);
    const compatibleHost = createDshCoreFixtureHost({ contract: fixture });
    const compatible = new LockedRc2CoreExtension(compatibleHost);

    await expect(compatible.probe()).resolves.toMatchObject({
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

    const driftedHost = createDshCoreFixtureHost({
      contract: {
        ...RC2_CORE_CONTRACT_OBSERVATION,
        implementationHashes: {
          ...RC2_CORE_CONTRACT_OBSERVATION.implementationHashes,
          workspace: "sha256:drifted",
        },
      },
    });
    const drifted = new LockedRc2CoreExtension(driftedHost);

    await expect(drifted.probe()).resolves.toMatchObject({
      status: "unsupported",
      capabilities: [],
      issues: [{ code: "ADAPTER_INCOMPATIBLE" }],
    });
    await expect(
      drifted.capture({ instanceId: "fixture-dsh", sessionId: "dsh-session-1" }),
    ).rejects.toMatchObject<Partial<SessionMaintenanceError>>({ code: "ADAPTER_INCOMPATIBLE" });
    expect(driftedHost.writes).toEqual([]);
  });

  it("restores every authoritative and derived domain after a post-artifact fault", async () => {
    const host = createDshCoreFixtureHost();
    const extension = new LockedRc2CoreExtension(host);
    const snapshot = await extension.capture({
      instanceId: "fixture-dsh",
      sessionId: "dsh-session-1",
      workspaceId: "workspace-fixture",
    });
    const before = host.domainDigests("dsh-session-1");
    host.setFault("after-session-mutation");

    await expect(
      extension.apply({
        snapshot,
        events: [
          {
            type: "user/message",
            seq: 4,
            time: 5,
            data: {
              id: "message-2",
              role: "user",
              source: { kind: "user" },
              content: [{ type: "text", text: "new fixture prompt" }],
            },
            surfaceOp: "append",
          },
        ],
        archived: true,
      }),
    ).rejects.toThrow("fixture fault: after-session-mutation");

    host.setFault(undefined);
    const restored = await extension.restore({ snapshot });

    expect(restored.digest).toBe(snapshot.before.digest);
    expect(host.domainDigests("dsh-session-1")).toEqual(before);
    expect(host.writes).toEqual([
      "append-events",
      "restore-session",
      "restore-workspace",
      "restore-projection",
      "reconcile-runtime",
    ]);
  });
});
