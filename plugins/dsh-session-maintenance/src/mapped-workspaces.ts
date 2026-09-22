/**
 * The instance's half of "true source → instance": registering the folders the Engine mapped.
 *
 * The Engine owns where a bucket's sessions live, because it owns the layout rule that decides the
 * project directory a session's `cwd` names. What it cannot do is make the instance *own* that
 * folder: workspace membership is the host's own durable record, reachable only from inside the
 * instance's process. During a prepared run this happens while the run attaches, which is why a
 * joined workspace appears by itself. A plain start — how an accepted instance actually runs — has
 * no such moment, so the sessions the Engine wrote would sit in a folder the instance knows nothing
 * about: not grouped, not ungrouped, simply invisible.
 *
 * So registration runs on every boot, from the same list the write-back wrote with:
 *
 * - `create(path, title)` is the host's own idempotent "create or reuse the workspace for this
 *   directory", so a second boot is not a second workspace, and a workspace the operator already
 *   owns keeps its title.
 * - `attachSession(id)` is what puts a session *in* the workspace. A record with no membership shows
 *   up as an empty workspace and the session stays ungrouped.
 *
 * Neither step may take the instance down: the registry is the host's own store, and a failure here
 * is a workspace that has not appeared *yet*. Passes repeat on a timer, because the Engine can write
 * more sessions while the instance runs and can itself start later than the instance does.
 */

/** The host services this needs; only the parts it uses, so the module stays testable. */
export interface MappedWorkspaceHost {
  readonly workspaceRegistry: {
    create(path: string, title?: string): Promise<{
      readonly id: string;
      readonly path: string;
      readonly title: string;
      attachSession(sessionId: string): Promise<void>;
    }>;
  };
}

/** One mapped folder as the Engine reports it, with the sessions it stored inside. */
export interface MappedFolder {
  readonly name: string;
  readonly path: string;
  readonly sessions?: readonly string[];
}

export interface MappedWorkspaceRegistrationOptions {
  readonly host: MappedWorkspaceHost;
  /** Reads the Engine's current mapping. Throws when the Engine is not reachable yet. */
  readonly listFolders: () => Promise<readonly MappedFolder[]>;
  readonly report?: (message: string) => void;
  /** How long to wait before another pass; a test injects a shorter one. */
  readonly intervalMs?: number;
}

/** What one pass did. */
export interface MappedWorkspacePass {
  /** Folders accepted by the host on this pass, which were not registered before. */
  readonly registered: readonly string[];
  readonly attached: number;
  /** Folders the host has not accepted yet; a non-empty list means another pass is worth running. */
  readonly failures: readonly string[];
}

const DEFAULT_INTERVAL_MS = 30_000;

export class MappedWorkspaceRegistration {
  private readonly workspaces = new Map<string, string>();
  private readonly members = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private disposed = false;
  private reportedFailure = false;

  constructor(private readonly options: MappedWorkspaceRegistrationOptions) {}

  /** Register everything the Engine reports, then keep watching for more. Returns a disposer. */
  start(): () => void {
    this.schedule(0);
    return () => { this.dispose(); };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass, exposed so a caller (and a test) can drive it without the timer. */
  async pass(): Promise<MappedWorkspacePass> {
    const folders = await this.options.listFolders();
    const registered: string[] = [];
    const failures: string[] = [];
    let attached = 0;
    for (const folder of folders) {
      try {
        const workspace = await this.options.host.workspaceRegistry.create(folder.path, folder.name);
        if (!this.workspaces.has(folder.path)) { this.workspaces.set(folder.path, folder.name); registered.push(folder.path); }
        for (const sessionId of folder.sessions ?? []) {
          const member = `${folder.path}\u0000${sessionId}`;
          if (this.members.has(member)) continue;
          await workspace.attachSession(sessionId);
          this.members.add(member);
          attached += 1;
        }
      } catch (error) {
        // A session the host cannot place yet — its header is not indexed, or the Engine wrote it
        // after this instance started — is retried next pass. Reported as one pending folder rather
        // than as a broken registration.
        failures.push(`${folder.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { registered, attached, failures };
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.cycle(); }, delayMs);
    this.timer.unref?.();
  }

  private cycle(): Promise<void> {
    if (this.running !== undefined) return this.running;
    this.running = (async () => {
      try {
        const result = await this.pass();
        if (result.registered.length > 0)
          this.report(`[dsh-session-maintenance] 已登记 ${result.registered.length} 个映射工作区，归属 ${result.attached} 个会话`);
        if (result.failures.length > 0) {
          if (!this.reportedFailure) {
            this.reportedFailure = true;
            this.report(`[dsh-session-maintenance] 映射工作区暂未全部登记，将自动重试：${result.failures[0]!}`);
          }
        } else { this.reportedFailure = false; }
      } catch (error) {
        // The Engine is not reachable yet: the next pass is the retry, and nothing here is fatal.
        if (!this.reportedFailure) {
          this.reportedFailure = true;
          this.report(`[dsh-session-maintenance] 维护引擎暂未接通，映射工作区将在接通后登记：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })().finally(() => {
      this.running = undefined;
      this.schedule(this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    });
    return this.running;
  }

  private report(message: string): void {
    this.options.report?.(message);
  }
}
