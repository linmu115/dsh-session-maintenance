import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { writeBusinessPageDeclarations } from "../scripts/business-pages-declarations.mjs";
it("publishes dependency-free types generated from shared contracts without startup code", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "dsm-business-api-"));
  await writeFile(join(temporary, ".synthetic-fixture"), "business page declaration test");
  try {
    await writeBusinessPageDeclarations(fileURLToPath(new URL("../../../", import.meta.url)), temporary);
    const declarations = await readFile(join(temporary, "business-pages.d.ts"), "utf8");
    expect(declarations).not.toMatch(/import\(|from ["']|EngineConnection|token/);
    const consumer = join(temporary, "consumer.ts");
    await writeFile(consumer, `import type { BusinessPageProvider, MaintenanceBusinessPagesService } from './business-pages.js';
const provider: BusinessPageProvider = { namespace: 'test', providerId: 'test', async snapshot() { return {title:'Test',revision:1,sections:[{id:'status',title:'Status',kind:'status',label:'Ready',state:'ready'}]}; }, async handleAction(request, signal) { return {message:request.operationId + signal.aborted}; } };
export function install(service: MaintenanceBusinessPagesService) { return service.register(provider); }`);
    const program = ts.createProgram([consumer], { noEmit: true, strict: true, types: [], target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
