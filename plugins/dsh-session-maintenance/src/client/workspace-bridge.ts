/**
 * The bridge the instance-side context menu talks to.
 *
 * The menu plugin owns the workspace right-click entry but cannot reach the Engine: it runs in
 * the same page, and the Engine is a loopback service the browser may not talk to directly. So
 * this plugin — which is loaded inside the DSH page and has a host half that owns the
 * authenticated Engine connection — publishes one global handle, and the menu plugin calls it.
 *
 * Two rules shape everything here:
 *
 *   * the handle exists only while this plugin is loaded, and disappears when it unloads, so a
 *     menu that finds no handle hides its entry instead of calling into nothing;
 *   * every answer is a value, never a thrown error. The caller is a foreign plugin's menu, and
 *     an exception crossing that boundary would surface as a broken menu item.
 *
 * The Engine being absent is a *deferred* outcome, not a failure: the instance is expected to run
 * without it, so the intent is kept and handed over once the Engine appears.
 */
import type { MaintenanceActions } from "./context.js";
import { ClientActionError } from "./context.js";
import type { WorkspaceJoinQueue } from "./workspace-join.js";

/** The global name the menu plugin looks for. */
export const WORKSPACE_BRIDGE_GLOBAL = "dshSessionMaintenance";

/** The only protocol version this bridge speaks; the caller must refuse anything else. */
export const WORKSPACE_BRIDGE_API_VERSION = 1;

/** The outcome codes the contract fixes; anything else is a failure by definition. */
export type WorkspaceBridgeCode = "joined" | "already-joined" | "engine-unreachable" | "engine-error" | "invalid-input";

export interface WorkspaceBridgeInput {
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly workspacePath?: string;
}

export interface WorkspaceBridgeResult {
  readonly ok: boolean;
  readonly code: WorkspaceBridgeCode;
  readonly message: string;
}

export interface WorkspaceBridgeHandle {
  readonly apiVersion: typeof WORKSPACE_BRIDGE_API_VERSION;
  joinWorkspace(input: WorkspaceBridgeInput): Promise<WorkspaceBridgeResult>;
}

/** The identity the host published for this instance; `declared: false` means the machine said nothing. */
export interface ClientIdentity {
  readonly instanceId: string;
  readonly profileId: string;
  readonly declared: boolean;
}

export interface WorkspaceBridgeOptions {
  readonly actions: MaintenanceActions;
  /** The durable queue: a join that cannot be delivered now is handed to it instead. */
  readonly queue: WorkspaceJoinQueue;
  readonly report?: (message: string) => void;
}

export interface WorkspaceBridge {
  readonly handle: WorkspaceBridgeHandle;
  /** Resolves the identity from the host once; safe to call repeatedly. */
  identity(): Promise<ClientIdentity>;
}

const UNDECLARED_MESSAGE = "本机未声明实例身份：请在 profiles/<profile>/cordis.patch.yml 的 id: session-maintenance 行配置 dshInstanceId 与 profileId 后再试。";
const INVALID_INPUT_MESSAGE = "工作区标识无效；请在展开的工作区菜单上重试。";

function result(ok: boolean, code: WorkspaceBridgeCode, message: string): WorkspaceBridgeResult {
  return { ok, code, message };
}

/** An undeclared identity is refused rather than sent: the Engine could not match it to any instance. */
function identityIssue(identity: ClientIdentity): WorkspaceBridgeResult | undefined {
  if (!identity.declared || identity.instanceId.length === 0 || identity.profileId.length === 0) return result(false, "invalid-input", UNDECLARED_MESSAGE);
  return undefined;
}

function refusal(error: unknown): WorkspaceBridgeResult {
  if (error instanceof ClientActionError) {
    // Only "nothing to talk to yet" is deferred by the caller; the other two are real answers.
    if (error.code === "engine-unreachable") return result(false, "engine-unreachable", error.message);
    if (error.code === "invalid-input") return result(false, "invalid-input", error.message);
    return result(false, "engine-error", error.message);
  }
  return result(false, "engine-error", error instanceof Error ? error.message : "维护操作失败");
}

/**
 * Build the bridge and the global handle.
 *
 * The handle is deliberately stateless about the identity: it asks the host for it whenever it
 * needs one, so an operator who declares the identity and reloads does not have to restart the
 * instance, and so the browser half never invents an identity of its own.
 */
export function createWorkspaceBridge(options: WorkspaceBridgeOptions): WorkspaceBridge {
  let pending: Promise<ClientIdentity> | undefined;
  const identity = async (): Promise<ClientIdentity> => {
    pending ??= options.actions.invoke({ operation: "identity" }).then(response => response.identity === undefined
      ? { instanceId: "", profileId: "", declared: false }
      : { instanceId: response.identity.instanceId, profileId: response.identity.profileId, declared: response.identity.declared })
      // A host that cannot answer is not an identity claim; the undeclared refusal covers it.
      .catch(() => ({ instanceId: "", profileId: "", declared: false }));
    return pending;
  };

  const handle: WorkspaceBridgeHandle = {
    apiVersion: WORKSPACE_BRIDGE_API_VERSION,
    async joinWorkspace(input: WorkspaceBridgeInput): Promise<WorkspaceBridgeResult> {
      const workspaceId = typeof input?.workspaceId === "string" ? input.workspaceId.trim() : "";
      if (workspaceId.length === 0) return result(false, "invalid-input", INVALID_INPUT_MESSAGE);
      const unresolved = identityIssue(await identity());
      if (unresolved !== undefined) return unresolved;
      const workspaceName = input.workspaceName?.trim() ?? "";
      const workspacePath = input.workspacePath?.trim() ?? "";
      try {
        const response = await options.actions.invoke({ operation: "join-workspace", workspaceId,
          ...(workspaceName.length === 0 ? {} : { workspaceName }), ...(workspacePath.length === 0 ? {} : { workspacePath }) });
        return result(true, response.code === "already-joined" ? "already-joined" : "joined", response.message);
      } catch (error) {
        const refused = refusal(error);
        if (refused.code !== "engine-unreachable") return refused;
        // The Engine is not there. Keep the intent so the join still happens later, and tell the
        // user that in the deferred wording rather than as a plain failure. Delivery is not
        // retried here: this call is already the failed attempt, and retrying it would recurse.
        const deferred = await options.queue.requestJoin({ workspaceId, workspaceName, workspacePath,
          requestedAt: new Date().toISOString() }, { flush: false }).catch(() => undefined);
        return result(false, "engine-unreachable", deferred?.message ?? refused.message);
      }
    },
  };
  return { handle, identity };
}

/**
 * Publish the handle for the menu plugin, and take it down again on unload.
 *
 * The previous value is restored rather than deleted: two generations of this plugin can briefly
 * overlap during a client reload, and the older one must not be left pointing at a disposed queue.
 */
export function installWorkspaceBridge(global: typeof globalThis, bridge: WorkspaceBridge, report?: (message: string) => void): () => void {
  const holder = global as unknown as Record<string, unknown>;
  const previous = holder[WORKSPACE_BRIDGE_GLOBAL];
  holder[WORKSPACE_BRIDGE_GLOBAL] = bridge.handle;
  report?.("[dsh-session-maintenance] 已暴露工作区加入句柄 dshSessionMaintenance");
  return () => {
    if (holder[WORKSPACE_BRIDGE_GLOBAL] === bridge.handle) {
      if (previous === undefined) delete holder[WORKSPACE_BRIDGE_GLOBAL];
      else holder[WORKSPACE_BRIDGE_GLOBAL] = previous;
    }
  };
}
