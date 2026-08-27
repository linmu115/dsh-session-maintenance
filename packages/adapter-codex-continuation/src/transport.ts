import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import type { AppServerTransport, CodexContinuationTarget } from "./types.js";

const execFileAsync = promisify(execFile);

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface NotificationWaiter {
  readonly method: string;
  readonly predicate: (params: unknown) => boolean;
  readonly resolve: (params: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface LaunchSpec {
  readonly command: string;
  readonly prefix: readonly string[];
}

function defaultCommand(): string {
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class StdioAppServerTransport implements AppServerTransport {
  private readonly target: CodexContinuationTarget;
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly waiters = new Set<NotificationWaiter>();
  private readonly buffered = new Map<string, unknown[]>();
  private terminalError: Error | undefined;
  private launchSpec: LaunchSpec | undefined;

  constructor(target: CodexContinuationTarget) {
    this.target = target;
  }

  async version(): Promise<string> {
    const launch = await this.resolveLaunchSpec();
    const { stdout } = await execFileAsync(launch.command, [...launch.prefix, "--version"], {
      windowsHide: true,
      env: this.environment(),
      timeout: 10_000,
    });
    const match = /codex-cli\s+([^\s]+)/u.exec(stdout.trim());
    if (match?.[1] === undefined) throw new Error(`Unrecognized Codex version output: ${stdout.trim()}`);
    return match[1];
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const child = this.ensureStarted();
    if (this.terminalError !== undefined) throw this.terminalError;
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const child = this.ensureStarted();
    child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  async waitForNotification<T>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs: number,
  ): Promise<T> {
    const buffered = this.buffered.get(method) ?? [];
    const index = buffered.findIndex((params) => predicate(params as T));
    if (index >= 0) {
      const [params] = buffered.splice(index, 1);
      return params as T;
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = {} as NotificationWaiter;
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for app-server notification: ${method}`));
      }, timeoutMs);
      Object.assign(waiter, {
        method,
        predicate: (params: unknown) => predicate(params as T),
        resolve: (params: unknown) => resolve(params as T),
        reject,
        timer,
      });
      this.waiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (child === undefined || child.exitCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(this.target.codexHome === undefined ? {} : { CODEX_HOME: this.target.codexHome }),
    };
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.process !== undefined) return this.process;
    const launch = this.launchSpec;
    if (launch === undefined) throw new Error("Codex launch command has not been probed");
    const child = spawn(launch.command, [...launch.prefix, "app-server", "--listen", "stdio://"], {
      windowsHide: true,
      env: this.environment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.acceptLine(line));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      if (this.process === child) this.process = undefined;
      this.failAll(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}): ${stderr.trim()}`));
    });
    return child;
  }

  private async resolveLaunchSpec(): Promise<LaunchSpec> {
    if (this.launchSpec !== undefined) return this.launchSpec;
    const command = this.target.command ?? defaultCommand();
    if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
      this.launchSpec = { command, prefix: [] };
      return this.launchSpec;
    }
    const shim = isAbsolute(command)
      ? command
      : (await execFileAsync("where.exe", [command], { windowsHide: true, timeout: 10_000 })).stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    if (shim === undefined) throw new Error(`Unable to resolve Codex npm shim: ${command}`);
    const entry = join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    try {
      await access(entry);
    } catch (error) {
      throw new Error(`Unsupported Codex command shim; expected official npm entry at ${entry}`, { cause: error });
    }
    this.launchSpec = { command: process.execPath, prefix: [entry] };
    return this.launchSpec;
  }

  private acceptLine(line: string): void {
    if (line.trim().length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if (typeof record.id === "number") {
      const pending = this.pending.get(record.id);
      if (pending === undefined) return;
      this.pending.delete(record.id);
      if (record.error !== undefined) {
        pending.reject(new Error(`App-server request failed: ${JSON.stringify(record.error)}`));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (typeof record.method !== "string") return;
    this.deliverNotification(record.method, record.params);
  }

  private deliverNotification(method: string, params: unknown): void {
    for (const waiter of this.waiters) {
      if (waiter.method !== method || !waiter.predicate(params)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(params);
      return;
    }
    const queue = this.buffered.get(method) ?? [];
    queue.push(params);
    this.buffered.set(method, queue.slice(-50));
  }

  private failAll(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(errorMessage(error));
    this.terminalError = failure;
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    this.waiters.clear();
  }
}
