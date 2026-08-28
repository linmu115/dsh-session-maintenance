import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("portable workspace", () => {
  it("contains no machine-bound runtime dependencies or credentials", async () => {
    const result = await execFileAsync(process.execPath, ["scripts/assert-portable.mjs"], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
    });
    expect(result.stdout).toMatch(/^portable:/u);
  }, 15_000);
});
