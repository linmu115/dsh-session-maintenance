import {
  CODEX_CONTINUATION_CONTRACT,
  CODEX_CONTINUATION_SCHEMA_FINGERPRINT,
} from "./contract.js";
import { StdioAppServerTransport } from "./transport.js";
import {
  ContinuationAdapterError,
  type AppServerTransport,
  type AppServerTransportFactory,
  type CodexContinuationTarget,
  type ContinuationProbe,
  type ContinuationVerification,
  type CreatedCodexThread,
} from "./types.js";

interface ThreadShape {
  readonly id: string;
  readonly cwd: string;
  readonly ephemeral: boolean;
  readonly historyMode: string;
}

interface ThreadStartResponse {
  readonly thread: ThreadShape;
}

interface TurnStartResponse {
  readonly turn: { readonly id: string };
}

interface TurnCompletedNotification {
  readonly threadId: string;
  readonly turn: { readonly id: string };
}

interface ThreadReadResponse {
  readonly thread: ThreadShape;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CodexContinuationAdapter {
  private readonly factory: AppServerTransportFactory;
  private readonly transports = new Map<string, AppServerTransport>();
  private readonly compatible = new Set<string>();

  constructor(factory: AppServerTransportFactory = (target) => new StdioAppServerTransport(target)) {
    this.factory = factory;
  }

  async probe(target: CodexContinuationTarget): Promise<ContinuationProbe> {
    const transport = this.transportFor(target);
    let actualVersion: string;
    try {
      actualVersion = await transport.version();
    } catch (error) {
      return this.unsupported(target.platformVersion, `Unable to read Codex version: ${asErrorMessage(error)}`);
    }
    if (
      target.platformVersion !== CODEX_CONTINUATION_CONTRACT.platformVersion ||
      actualVersion !== CODEX_CONTINUATION_CONTRACT.platformVersion
    ) {
      return this.unsupported(actualVersion, `Expected Codex ${CODEX_CONTINUATION_CONTRACT.platformVersion}, received ${actualVersion}`);
    }
    try {
      await transport.request("initialize", {
        clientInfo: {
          name: "dsh-session-maintenance",
          title: "DSH Session Maintenance",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });
      await transport.notify("initialized");
      this.compatible.add(target.id);
      return {
        status: "compatible",
        platformVersion: actualVersion,
        schemaFingerprint: CODEX_CONTINUATION_SCHEMA_FINGERPRINT,
        capabilities: ["create-thread", "start-turn", "read-thread"],
        issues: [],
      };
    } catch (error) {
      return this.unsupported(actualVersion, `Codex app-server initialization failed: ${asErrorMessage(error)}`);
    }
  }

  async create(input: {
    readonly prompt: string;
    readonly target: CodexContinuationTarget;
  }): Promise<CreatedCodexThread> {
    if (input.prompt.trim().length === 0) {
      throw new ContinuationAdapterError("CONTINUATION_CREATE_FAILED", "Continuation prompt is empty");
    }
    const transport = await this.requireCompatible(input.target);
    let threadId: string | undefined;
    try {
      const started = await transport.request<ThreadStartResponse>("thread/start", {
        ...(input.target.model === undefined ? {} : { model: input.target.model }),
        cwd: input.target.cwd,
        runtimeWorkspaceRoots: [...input.target.runtimeWorkspaceRoots],
        ...(input.target.permissions === undefined ? {} : { permissions: input.target.permissions }),
        ephemeral: false,
        historyMode: CODEX_CONTINUATION_CONTRACT.historyMode,
        sessionStartSource: "startup",
      });
      threadId = started.thread.id;
      const turn = await transport.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
      });
      await transport.waitForNotification<TurnCompletedNotification>(
        "turn/completed",
        (notification) => notification.threadId === threadId && notification.turn.id === turn.turn.id,
        300_000,
      );
      return {
        threadId,
        turnId: turn.turn.id,
        status: "turn-completed",
        cwd: started.thread.cwd,
      };
    } catch (error) {
      throw new ContinuationAdapterError(
        "CONTINUATION_CREATE_FAILED",
        `Codex continuation creation failed: ${asErrorMessage(error)}`,
        { ...(threadId === undefined ? {} : { threadId }), cause: error },
      );
    }
  }

  async verify(
    created: CreatedCodexThread,
    target: CodexContinuationTarget,
  ): Promise<ContinuationVerification> {
    const transport = await this.requireCompatible(target);
    try {
      const response = await transport.request<ThreadReadResponse>("thread/read", {
        threadId: created.threadId,
        includeTurns: true,
      });
      const thread = response.thread;
      if (
        thread.id !== created.threadId ||
        thread.ephemeral ||
        thread.historyMode !== CODEX_CONTINUATION_CONTRACT.historyMode
      ) {
        throw new Error("Codex returned a non-persistent or mismatched thread");
      }
      return {
        ok: true,
        threadId: thread.id,
        cwd: thread.cwd,
        historyMode: "paginated",
      };
    } catch (error) {
      throw new ContinuationAdapterError(
        "CONTINUATION_VERIFY_FAILED",
        `Codex continuation verification failed: ${asErrorMessage(error)}`,
        { threadId: created.threadId, cause: error },
      );
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.transports.values()].map((transport) => transport.close()));
    this.transports.clear();
    this.compatible.clear();
  }

  private async requireCompatible(target: CodexContinuationTarget): Promise<AppServerTransport> {
    if (!this.compatible.has(target.id)) {
      const probe = await this.probe(target);
      if (probe.status !== "compatible") {
        throw new ContinuationAdapterError(
          "ADAPTER_INCOMPATIBLE",
          probe.issues[0]?.message ?? "Codex continuation adapter is incompatible",
        );
      }
    }
    return this.transportFor(target);
  }

  private transportFor(target: CodexContinuationTarget): AppServerTransport {
    const existing = this.transports.get(target.id);
    if (existing !== undefined) return existing;
    const transport = this.factory(target);
    this.transports.set(target.id, transport);
    return transport;
  }

  private unsupported(platformVersion: string, message: string): ContinuationProbe {
    return {
      status: "unsupported",
      platformVersion,
      schemaFingerprint: CODEX_CONTINUATION_SCHEMA_FINGERPRINT,
      capabilities: [],
      issues: [{ code: "ADAPTER_INCOMPATIBLE", message }],
    };
  }
}
