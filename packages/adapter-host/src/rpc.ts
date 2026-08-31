import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AdapterManifestV1, JsonValue } from "@linmu/dsh-session-contracts";

export interface AdapterRpcWorker {
  request(method: string, payload: JsonValue): Promise<JsonValue>;
  close(): Promise<void>;
}

export interface AdapterWorkerFactory {
  launch(registration: {
    readonly entryPoint: string;
    readonly manifest: AdapterManifestV1;
  }): Promise<AdapterRpcWorker>;
}

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

export class NodeAdapterRpcWorker implements AdapterRpcWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private stdoutBuffer = "";
  private closed = false;

  constructor(entryPoint: string) {
    this.child = spawn(process.execPath, [entryPoint], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      this.failAll(new Error(`Adapter process exited (${code ?? signal ?? "unknown"})`));
    });
  }

  request(method: string, payload: JsonValue): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new Error("Adapter RPC worker is closed"));
    const id = ++this.nextId;
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, payload })}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
      else this.child.once("exit", () => resolve());
    });
  }

  private read(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let response: { readonly id?: unknown; readonly ok?: unknown; readonly result?: unknown; readonly error?: unknown };
      try {
        response = JSON.parse(line) as typeof response;
      } catch {
        this.failAll(new Error("Adapter process emitted invalid JSON RPC"));
        continue;
      }
      if (!Number.isSafeInteger(response.id)) continue;
      const pending = this.pending.get(response.id as number);
      if (pending === undefined) continue;
      this.pending.delete(response.id as number);
      if (response.ok === true) pending.resolve(response.result as JsonValue);
      else pending.reject(new Error("Adapter RPC request failed"));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class NodeAdapterWorkerFactory implements AdapterWorkerFactory {
  async launch(registration: { readonly entryPoint: string }): Promise<AdapterRpcWorker> {
    return new NodeAdapterRpcWorker(registration.entryPoint);
  }
}
