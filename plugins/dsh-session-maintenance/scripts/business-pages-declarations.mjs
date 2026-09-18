import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
/** Resolve shared Zod-inferred DTOs into a dependency-free public declaration, without copying contracts by hand. */
export async function writeBusinessPageDeclarations(workspaceRoot, lib) {
  const source = join(workspaceRoot, "plugins/dsh-session-maintenance/src/business-pages-api.ts");
  const configPath = join(workspaceRoot, "plugins/dsh-session-maintenance/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(workspaceRoot, "plugins/dsh-session-maintenance"));
  const program = ts.createProgram([source], parsed.options);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(source);
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(sourceFile));
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;
  const declarations = exports.filter(symbol => symbol.flags & ts.SymbolFlags.Alias).map(symbol => {
    const type = checker.getDeclaredTypeOfSymbol(checker.getAliasedSymbol(symbol));
    const text = checker.typeToString(type, sourceFile, flags);
    if (/import\(|\bz\.|\bZod/.test(text)) throw new Error(`Public DTO was not flattened: ${symbol.name}`);
    return `export type ${symbol.name} = ${text};`;
  });
  const sourceText = await readFile(source, "utf8");
  declarations.push(sourceText.slice(sourceText.indexOf("/**")));
  await writeFile(join(lib, "business-pages.d.ts"), declarations.join("\n\n"));
}
