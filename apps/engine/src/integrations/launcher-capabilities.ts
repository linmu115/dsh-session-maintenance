import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { readJsonIfPresent } from "./bindings.js";
import { windowsSystemTool } from "./windows-tools.js";

const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), catalogFile: z.literal("config.json"),
  supportedPhases: z.array(z.enum(["prepare", "beforeStop", "afterExit", "abort"])),
  processId: z.number().int().positive().max(4_294_967_295),
  executable: z.strictObject({ path: z.string().refine(isAbsolute), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
});

async function runningExecutable(pid: number): Promise<string> {
  if (pid === process.pid) return process.execPath;
  if (process.platform === "linux") return realpath(`/proc/${pid}/exe`);
  if (process.platform === "win32") {
    const program = windowsSystemTool("WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await promisify(execFile)(program, ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); (Get-Process -Id ${pid} -ErrorAction Stop).Path`], { windowsHide: true, timeout: 5000, maxBuffer: 8192 });
    return result.stdout.trim();
  }
  return (await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 5000, maxBuffer: 8192 })).stdout.trim();
}
const binaryDigests = new Map<string, { stamp: string; digest: string }>();
async function executableDigest(path: string): Promise<string> {
  const before = await stat(path, { bigint: true });
  const stamp = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
  const saved = binaryDigests.get(path);
  if (saved?.stamp === stamp) return saved.digest;
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  const after = await stat(path, { bigint: true });
  if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== stamp) throw new Error("Launcher changed during hash");
  const digest = hash.digest("hex");
  if (binaryDigests.size > 16) binaryDigests.clear();
  binaryDigests.set(path, { stamp, digest });
  return digest;
}

/** A persisted configuration alone cannot establish that the host still implements the Hook. */
export async function inspectLauncherCapabilities(dataRoot: string): Promise<{ digest: string | null; issue: string | null }> {
  try {
    const receipt = receiptSchema.safeParse(await readJsonIfPresent(join(dataRoot, "external-lifecycle-capabilities.json")));
    if (!receipt.success || new Set(receipt.data.supportedPhases).size !== 4) return { digest: null, issue: "Launcher 尚未提供完整启动接入的能力信息，请更新支持此功能的 Launcher 并启动一次。" };
    const [expected, active] = await Promise.all([realpath(receipt.data.executable.path), runningExecutable(receipt.data.processId).then(path => realpath(path))]);
    if (expected !== active) return { digest: null, issue: "能力信息与当前 Launcher 进程不一致，请打开所选 Launcher 后重新检查。" };
    const digest = await executableDigest(expected);
    if (digest !== receipt.data.executable.sha256) return { digest: null, issue: "Launcher 程序在能力检查后已改变，请重新启动 Launcher 并修复接入。" };
    const { processId: _processId, ...stable } = receipt.data;
    return { digest: createHash("sha256").update(JSON.stringify(stable)).digest("hex"), issue: null };
  } catch { return { digest: null, issue: "Launcher 的能力信息或程序不可读取，请重新检查 Launcher 安装。" }; }
}
