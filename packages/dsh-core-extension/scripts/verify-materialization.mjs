import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { RC2_CORE_HOST_MATERIALIZATION } from "../dist/materialization.js";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const source = await readFile(new URL("../src/rc2-host.ts", import.meta.url), "utf8");
const normalizedSource = Buffer.from(source.replaceAll("\r\n", "\n"), "utf8");
const artifact = await readFile(new URL("../dist/rc2-host.js", import.meta.url));
const observed = {
  sourceHash: sha256(normalizedSource),
  artifactHash: sha256(artifact),
};

for (const key of ["sourceHash", "artifactHash"]) {
  if (observed[key] !== RC2_CORE_HOST_MATERIALIZATION[key]) {
    throw new Error(
      `Core host materialization drifted at ${key}: expected ${RC2_CORE_HOST_MATERIALIZATION[key]}, got ${observed[key]}`,
    );
  }
}
