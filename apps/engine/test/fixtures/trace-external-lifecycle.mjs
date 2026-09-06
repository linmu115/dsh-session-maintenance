import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

const separator = process.argv.indexOf("--");
if (separator < 4 || process.argv[2] !== "--trace-file") {
  process.stderr.write("trace-external-lifecycle: invalid arguments\n");
  process.exitCode = 2;
} else {
  const traceFile = process.argv[3];
  const command = process.argv[separator + 1];
  const args = process.argv.slice(separator + 2);
  if (command === undefined) {
    process.stderr.write("trace-external-lifecycle: missing command\n");
    process.exitCode = 2;
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString("utf8");
    let requestDetail = "invalid-json";
    try {
      const request = JSON.parse(input);
      requestDetail = [
        `phase=${String(request.phase ?? "unknown")}`,
        `instance=${String(request.instanceId ?? "-")}`,
        `profile=${String(request.profileId ?? "-")}`,
        `runtime=${String(request.runtimeVersion ?? "-")}`,
        `web=${String(request.web ?? "-")}`,
      ].join(" ");
    } catch {}
    await appendFile(traceFile, `${new Date().toISOString()}\tprovider.invoke\t${requestDetail}\n`, "utf8");

    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(input);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    const output = Buffer.concat(stdout);
    let responseDetail = `exit=${exitCode} invalid-json`;
    try {
      const response = JSON.parse(output.toString("utf8"));
      responseDetail = [
        `exit=${exitCode}`,
        `enabled=${String(response.enabled ?? "-")}`,
        `handle=${String(response.handle != null)}`,
        `launcherArgs=${String(response.launch?.launcherArgs?.length ?? 0)}`,
        `appArgs=${String(response.launch?.args?.length ?? 0)}`,
      ].join(" ");
    } catch {}
    await appendFile(traceFile, `${new Date().toISOString()}\tprovider.result\t${responseDetail}\n`, "utf8");
    process.stdout.write(output);
    process.stderr.write(Buffer.concat(stderr));
    process.exitCode = exitCode;
  }
}
