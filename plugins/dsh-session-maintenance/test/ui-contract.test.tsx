import { describe, expect, it } from "vitest";

import type { ClientContext } from "../src/client/context.js";
import { SUPPORTED_CLIENT_FINGERPRINT, verifyUiContract } from "../src/client/ui-contract.js";

function context(): ClientContext {
  return {
    sessions: { list: { getSnapshot: () => ({ current: "session-1", byId: { "session-1": { title: "Fixture session" } } }), subscribe: () => () => undefined } },
    slots: { inject: (_name, callback) => callback(), register: () => () => undefined },
    uiConversation: { events: { register: () => () => undefined } },
    inject: () => ({ dispose: () => undefined }),
    effect: () => undefined,
    get: () => undefined,
  };
}

function root(className: string, hasTitle: boolean): ParentNode {
  const row = { className, querySelector: () => hasTitle ? ({ textContent: "Fixture session" }) : null };
  return { querySelectorAll: () => [row] } as unknown as ParentNode;
}

describe("DSH 0.1.1-rc.2 UI contract", () => {
  it("accepts the captured service and selector contract", () => {
    expect(verifyUiContract(context(), root("_sessionRow_rc2_17", true))).toEqual({ compatible: true, fingerprint: SUPPORTED_CLIENT_FINGERPRINT });
  });

  it("fails closed when the session-row contract drifts", () => {
    expect(verifyUiContract(context(), root("_conversationRow_future_1", true))).toMatchObject({ compatible: false, reason: "UI_CONTRACT_INCOMPATIBLE" });
  });
});
