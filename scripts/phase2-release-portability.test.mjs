import assert from "node:assert/strict";
import { test } from "node:test";
import { completeComponentInventory, PHASE2_COMPONENT_PATHS, normalizedTextHash, validDsh015HostProvenance } from "./phase2-release-contract.mjs";
import { missingPackagedDocumentLinks, rewritePackagedReadmeLinks } from "./phase2-readme.mjs";

test("component inventory requires each of the eight source components exactly once", () => {
  const components = PHASE2_COMPONENT_PATHS.map(sourcePath => ({ sourcePath }));
  assert.equal(completeComponentInventory(components), true);
  assert.equal(completeComponentInventory(components.slice(1)), false);
  assert.equal(completeComponentInventory([...components.slice(1), components[1]]), false);
  assert.equal(completeComponentInventory([...components, { sourcePath: "packages/unknown" }]), false);
});

test("current host provenance checks source, built artifact, archive entry, and normalized bytes", () => {
  const artifact = Buffer.from("export const synthetic = true;\n");
  const expected = { adapterId: "dsh-0.1.5", sourcePath: "source.ts", buildPath: "build.js", artifactPath: "lib/dsh-015-host.js",
    sourceHash: normalizedTextHash(Buffer.from("synthetic source\n")), artifactHash: normalizedTextHash(artifact) };
  const entries = new Map([["package/lib/dsh-015-host.js", artifact]]);
  assert.equal(validDsh015HostProvenance(expected, expected, entries), true);
  assert.equal(validDsh015HostProvenance(expected, expected, new Map([["package/lib/dsh-015-host.js", Buffer.from("export const synthetic = true;\r\n")]])), true);
  for (const key of Object.keys(expected)) assert.equal(validDsh015HostProvenance({ ...expected, [key]: "changed" }, expected, entries), false);
  assert.equal(validDsh015HostProvenance(null, expected, entries), false);
  assert.equal(validDsh015HostProvenance(expected, expected, new Map([["package/lib/rc2-host.js", artifact]])), false);
  assert.equal(validDsh015HostProvenance(expected, expected, new Map([["package/lib/dsh-015-host.js", Buffer.from("tampered")]])), false);
});

test("packaged README uses bundled documentation and commit-bound source links", () => {
  const commit = "a".repeat(40);
  const text = "[升级](../../docs/deployment/UPGRADE.md) [构建](../../README.md#构建与安装) [网页](https://example.com)";
  const rewritten = rewritePackagedReadmeLinks(text, "plugins/dsh-session-maintenance/README.md", commit);
  assert.match(rewritten, /\[升级\]\(docs\/deployment\/UPGRADE\.md\)/u);
  assert.ok(rewritten.includes(`https://github.com/linmu115/dsh-session-maintenance/blob/${commit}/README.md#构建与安装`));
  assert.ok(rewritten.includes("[网页](https://example.com)"));
  const upgrade = rewritePackagedReadmeLinks("[恢复](RECOVERY.md) [README](../../README.md)", "docs/deployment/UPGRADE.md", commit);
  assert.ok(upgrade.includes("[恢复](RECOVERY.md)"));
  assert.ok(upgrade.includes(`/blob/${commit}/README.md`));
  assert.throws(() => rewritePackagedReadmeLinks(text, "plugins/dsh-session-maintenance/README.md", "main"), /exact source commit/u);
  assert.throws(() => rewritePackagedReadmeLinks("[escape](../../../outside.md)", "plugins/dsh-session-maintenance/README.md", commit), /escapes/u);
});

test("archive validation rejects missing and escaping README/doc targets", () => {
  const entries = new Map([
    ["package/README.md", Buffer.from("[升级](docs/deployment/UPGRADE.md) [来源](https://example.com/source)")],
    ["package/docs/deployment/UPGRADE.md", Buffer.from("[恢复](RECOVERY.md)")],
    ["package/docs/deployment/RECOVERY.md", Buffer.from("# 恢复")],
  ]);
  assert.deepEqual(missingPackagedDocumentLinks(entries), []);
  entries.delete("package/docs/deployment/RECOVERY.md");
  assert.equal(missingPackagedDocumentLinks(entries).length, 1);
  entries.set("package/README.md", Buffer.from("[escape](../../README.md)"));
  assert.equal(missingPackagedDocumentLinks(entries).length, 2);
});
