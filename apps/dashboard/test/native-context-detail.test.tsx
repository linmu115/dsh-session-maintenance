import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { nativeContextStateSchema } from "../../../packages/contracts/src/index.js";
import { NativeContextDetail } from "../src/native-context-detail.js";

it("keeps authority, active ranges and actual release receipt distinct without unsafe generic mutation", () => {
  const state = nativeContextStateSchema.parse({ schemaVersion: 1, kind: "native-context", ownerSessionId: "target", sources: [{ referenceId: "ref", sourceSessionId: "source", sourceVersionId: "fixed-v", cutoffEventId: "reply40", title: "来源标题", enabled: false, window: [{ startEventId: "request38", endEventId: "reply38" }, { startEventId: "request40", endEventId: "reply40" }], authorityState: "sent" }], materials: [{ materialId: "material", eventSeq: 5, referenceIds: ["ref"], kind: "read", bytes: 1234, contentHash: "hash", ranges: [{ referenceId: "ref", eventId: "reply38", start: 0, end: 99 }], state: "release-pending", pinnedByUser: true, pinnedByModel: false, createdAt: "2026-09-15" }], operations: [{ operationId: "op", digest: "digest", action: "release", actor: "model", executionId: "execution", state: "pending-next-step", materialIds: ["material"], reason: "等待原生请求边界", createdAt: "2026-09-15" }], trimmedMaterials: 0, trimmedOperations: 0 });
  const html = renderToStaticMarkup(<NativeContextDetail state={state} onOpenSession={() => undefined}/>);
  expect(html).toContain("固定授权上限"); expect(html).toContain("当前披露窗口"); expect(html).toContain("实际保留材料"); expect(html).toContain("等待释放"); expect(html).toContain("等待下一次原生请求"); expect(html).toContain("用户固定保留"); expect(html).not.toContain("已释放</"); expect(html).not.toContain("textarea"); expect(html).not.toContain("保存编辑");
});
