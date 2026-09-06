/** SCM's public browser extension contract; the menu host owns selection and UI. */
export interface SessionMenuTarget {
  readonly nativeSessionId: string;
  readonly workspaceId: string | null;
}

export interface SessionMenuAction {
  readonly id: string;
  readonly label: string;
  readonly getState?: (target: SessionMenuTarget) => {
    readonly visible?: boolean;
    readonly enabled?: boolean;
    readonly disabledReason?: string;
  };
  readonly run: (target: SessionMenuTarget, options: { readonly signal: AbortSignal }) =>
    void | { readonly message: string } | Promise<void | { readonly message: string }>;
}

export interface SessionMenuActionHost {
  readonly menuApiVersion: 1;
  registerActions(owner: string, actions: readonly SessionMenuAction[]): () => void;
}
