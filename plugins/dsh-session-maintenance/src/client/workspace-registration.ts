import type { MaintenanceActions } from "./context.js";

/**
 * Register the mapped folders as this instance's own workspaces.
 *
 * Writing sessions into a folder is not enough for the instance to show them: `@deepseek-ai/dsh-workspace`
 * resolves every session's `cwd` and keeps the session only under the workspace whose registered path
 * equals it. So the Engine creates one folder per mapped bucket and this side — the only side that
 * owns the instance's workspace registry — registers exactly those folders, using the host's own
 * `create`, which is idempotent: an existing folder with the same canonical path is returned, never
 * duplicated or retitled.
 *
 * Failures are reported, not thrown: this runs while the page is loading, and a registry the host
 * refuses must not break the sidebar.
 */
export interface WorkspaceRegistrationHost {
  readonly create?: (input: { readonly path: string; readonly title: string }) => Promise<unknown>;
}

export async function registerMappedWorkspaces(input: {
  readonly actions: MaintenanceActions;
  readonly workspaces: WorkspaceRegistrationHost | undefined;
  readonly onFeedback: (message: string) => void;
}): Promise<number> {
  if (input.workspaces?.create === undefined) return 0;
  const listed = await input.actions.invoke({ operation: "workspace-folders" })
    .catch((error: unknown) => { input.onFeedback(error instanceof Error ? error.message : "无法读取映射工作区"); return undefined; });
  const folders = listed?.folders ?? [];
  if (folders.length === 0) return 0;
  let registered = 0;
  for (const folder of folders) {
    try {
      await input.workspaces.create({ path: folder.path, title: folder.name });
      registered += 1;
    } catch (error) {
      input.onFeedback(`无法登记工作区「${folder.name}」：${error instanceof Error ? error.message : "宿主拒绝"}`);
    }
  }
  input.onFeedback(`已登记 ${registered}/${folders.length} 个映射工作区`);
  return registered;
}
