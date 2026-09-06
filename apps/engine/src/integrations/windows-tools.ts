import { isAbsolute, join } from "node:path";
import { IntegrationError } from "./bindings.js";

export function windowsSystemTool(...parts: string[]): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (root === undefined || !isAbsolute(root)) throw new IntegrationError("SYSTEM_TOOLS_UNAVAILABLE", "无法确定 Windows 系统工具目录，请检查启动环境。", 503);
  return join(root, "System32", ...parts);
}
