import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RunCenterPage, type RunCenterApi } from "../src/run-center.js";

it("mounts independent import controls while projection diagnostics are still loading", () => {
  const api = { listProjectionRuns: () => new Promise(() => {}) } as unknown as RunCenterApi;
  const html = renderToStaticMarkup(createElement(RunCenterPage, { api }));
  expect(html).toContain("正在读取运行、租约和断点");
  expect(html).toContain("Codex 导入进度");
  expect(html).toContain("更新已登记的 Codex 来源");
});
