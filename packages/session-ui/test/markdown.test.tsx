import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownView } from "../src/markdown.js";

describe("MarkdownView", () => {
  it("renders common markdown without activating raw HTML or unsafe links", () => {
    const html = renderToStaticMarkup(<MarkdownView>{"# Note\n<script>alert(1)</script>\n[bad](javascript:alert(2))\n[good](https://example.com)\n- [x] done\n\n| A | B |\n| --- | --- |\n| ~~old~~ | new |"}</MarkdownView>);
    expect(html).toContain("<h1>Note</h1>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://example.com");
    expect(html).toContain("checked");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>old</del>");
  });
});
