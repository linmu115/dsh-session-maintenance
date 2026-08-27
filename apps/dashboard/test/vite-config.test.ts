import { describe, expect, it } from "vitest";

import { canonicalizeDashboardHtml } from "../vite.config.js";

describe("Dashboard build input", () => {
  it("gives Vite one canonical index.html for LF and CRLF checkouts", () => {
    const lf = "<body>\n  <div id=\"root\"></div>\n</body>\n";
    const crlf = lf.replaceAll("\n", "\r\n");

    expect(canonicalizeDashboardHtml(crlf)).toBe(lf);
    expect(canonicalizeDashboardHtml(lf)).toBe(lf);
  });
});
