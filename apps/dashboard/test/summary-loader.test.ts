import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DashboardOffline } from "../src/app.js";
import { loadDashboardSummary, type DashboardSummaryApi } from "../src/summary-loader.js";

describe("Dashboard summary baseline", () => {
  it("keeps the legacy summary loader available outside the reading entry", async () => {
    const calls: string[] = [];
    const api: DashboardSummaryApi = {
      overview: async () => {
        calls.push("overview");
        return { sessions: 1, conflicts: 0, unmapped: 1, unresolvedTransactions: 0, instances: [] };
      },
      listCanonicalProjects: async () => {
        calls.push("projects");
        return { schemaVersion: 1, projects: [], unclassified: [] };
      },
    };
    await loadDashboardSummary(api);
    expect(calls).toEqual(["overview", "projects"]);
  });

  it("renders an actionable offline state without a runtime credential", () => {
    const html = renderToStaticMarkup(DashboardOffline());
    expect(html).toContain("请重新打开看板");
    expect(html).toContain("从 Maintenance 启动入口重新打开");
  });
});
