import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownView } from "../src/index.js";

describe("MarkdownView", () => {
  it("renders common markdown without activating raw HTML or unsafe links", () => {
    const html = renderToStaticMarkup(<MarkdownView>{"# Note\n<script>alert(1)</script>\n[bad](javascript:alert(2))\n[good](https://example.com)"}</MarkdownView>);
    expect(html).toContain("<h1>Note</h1>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://example.com");
  });
});
