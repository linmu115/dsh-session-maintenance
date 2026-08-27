import { spawn } from "node:child_process";

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function dashboardLaunchCommand(input: string, platform: NodeJS.Platform = process.platform): LaunchCommand {
  const url = new URL(input);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new TypeError("看板入口必须是 Maintenance Engine 签发的本机 HTTP 地址");
  }

  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url.href] };
  }
  if (platform === "darwin") return { command: "open", args: [url.href] };
  return { command: "xdg-open", args: [url.href] };
}

export async function launchDashboard(input: string): Promise<void> {
  const target = dashboardLaunchCommand(input);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(target.command, [...target.args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
