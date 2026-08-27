import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DashboardOffline } from "../src/app.js";
import { loadDashboardSummary, type DashboardSummaryApi } from "../src/summary-loader.js";

describe("Dashboard summary baseline", () => {
  it("loads only overview and one bounded session page on first render", async () => {
    const calls: string[] = [];
    const api: DashboardSummaryApi = {
      overview: async () => {
        calls.push("overview");
        return { sessions: 1, conflicts: 0, unmapped: 1, unresolvedTransactions: 0, instances: [] };
      },
      listSessions: async (query) => {
        calls.push(`sessions:${query?.limit}`);
        return { items: [] };
      },
    };
    await loadDashboardSummary(api);
    expect(calls).toEqual(["overview", "sessions:25"]);
  });

  it("renders an actionable offline state without a runtime credential", () => {
    const html = renderToStaticMarkup(DashboardOffline());
    expect(html).toContain("缺少本次启动凭据");
    expect(html).toContain("不会读取 Engine capability");
  });
});
