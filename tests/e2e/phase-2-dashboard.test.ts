import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("packaged Dashboard boundary", () => {
  it("uses the Engine /dashboard base and contains no host capability or local path", async () => {
    const root = join(process.cwd(), "apps", "dashboard", "dist");
    const index = await readFile(join(root, "index.html"), "utf8");
    expect(index).toMatch(/(?:src|href)="\/dashboard\/assets\//u);
    const scripts = (await readdir(join(root, "assets"))).filter((name) => name.endsWith(".js"));
    const body = (await Promise.all(scripts.map((name) => readFile(join(root, "assets", name), "utf8")))).join("\n");
    // The compiled React runtime contains regex source such as `s:/.../` and
    // escaped backslashes, so a generic drive/UNC regex produces false
    // positives. Reject credentials plus every host root available to this
    // build in native, slash-normalized, and JavaScript-escaped forms.
    expect(body).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/u);
    const roots = [process.cwd(), process.env.USERPROFILE, process.env.DSH_HOME].filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
    for (const rootPath of roots) {
      for (const spelling of new Set([
        rootPath,
        rootPath.replaceAll("\\", "/"),
        JSON.stringify(rootPath).slice(1, -1),
      ])) expect(body).not.toContain(spelling);
    }
  });
});
