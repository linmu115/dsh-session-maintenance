import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SafeMarkdown } from "../src/safe-markdown.js";

describe("safe static markdown", () => {
  it("renders common Markdown while keeping HTML, images and unsafe links inert", () => {
    const html = renderToStaticMarkup(createElement(SafeMarkdown, {
      children: "# 标题\n\n- 项目\n\n`code`\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[危险](javascript:alert(3))\n\n![远程](https://example.com/a.png)",
    }));
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<li>项目</li>");
    expect(html).toContain("<code>code</code>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("[图片：远程]");
  });
});
