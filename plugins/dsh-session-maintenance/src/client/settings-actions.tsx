import type { MaintenanceActions } from "./context.js";
import { openDashboard } from "./dashboard-entry.js";

export const PANEL_FIELDS = [
  "codexInstanceId", "dshInstanceId", "workspaceMappingId", "syncSingleSidedTitle", "scanScope", "backupRetention", "allowBatchSafeApply",
] as const;

export interface ActionFeedback { readonly message: string; readonly reference?: string }

export function createActionPanel(actions: MaintenanceActions, input: {
  readonly instanceId?: string;
  readonly currentSessionId: () => string | undefined;
}): { readonly element: HTMLElement; readonly open: () => void; readonly close: () => void; readonly dispose: () => void } {
  const backdrop = document.createElement("div");
  backdrop.className = "dsm-entry-backdrop";
  backdrop.hidden = true;
  const panel = document.createElement("section");
  panel.className = "dsm-entry-panel";
  panel.setAttribute("aria-label", "会话维护参数与操作");
  panel.innerHTML = `<header><strong>会话维护</strong><button type="button" data-close aria-label="关闭">×</button></header>
    <div class="dsm-entry-fields">
      <label>Codex 实例 ID<input data-field="codexInstanceId"></label>
      <label>DSH 实例 ID<input data-field="dshInstanceId"></label>
      <label>工作区映射 ID<input data-field="workspaceMappingId"></label>
      <label><input type="checkbox" data-field="syncSingleSidedTitle"> 同步单边标题</label>
      <label>扫描范围<select data-field="scanScope"><option value="current">当前</option><option value="registered">已登记</option></select></label>
      <label>备份保留数<input type="number" min="1" max="10000" data-field="backupRetention"></label>
      <label><input type="checkbox" data-field="allowBatchSafeApply"> 允许批量应用安全计划</label>
    </div>
    <div class="dsm-entry-actions">
      <button type="button" data-action="save">保存参数</button>
      <button type="button" data-action="scan">扫描当前会话</button>
      <button type="button" data-action="sync">同步当前会话</button>
      <button type="button" data-action="dashboard">打开会话维护看板</button>
      <button type="button" disabled title="后续阶段提供">创建 Codex 延续任务</button>
    </div><output data-feedback>尚未执行操作</output>`;
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  const feedback = panel.querySelector<HTMLOutputElement>("[data-feedback]")!;
  const setFeedback = (value: ActionFeedback) => { feedback.textContent = value.reference === undefined ? value.message : `${value.message} · ${value.reference}`; };
  const current = () => {
    const sessionId = input.currentSessionId();
    if (sessionId === undefined) throw new Error("当前没有打开的 DSH 会话");
    return sessionId;
  };
  const run = async (work: () => Promise<ActionFeedback>) => {
    feedback.textContent = "正在执行…";
    try { setFeedback(await work()); } catch (error) { setFeedback({ message: error instanceof Error ? error.message : "操作失败" }); }
  };
  const hydrate = async () => {
    try {
      const result = await actions.invoke({ operation: "settings:get" });
      const settings = result.settings as Record<string, unknown> | undefined;
      if (settings === undefined) return;
      for (const name of PANEL_FIELDS) {
        const field = panel.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${name}"]`)!;
        const value = settings[name];
        if (field instanceof HTMLInputElement && field.type === "checkbox") field.checked = value === true;
        else field.value = value === null || value === undefined ? "" : String(value);
      }
    } catch (error) { setFeedback({ message: error instanceof Error ? error.message : "无法读取维护参数" }); }
  };
  const click = (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
    const action = button?.dataset.action;
    if (button?.dataset.close !== undefined) { backdrop.hidden = true; return; }
    if (action === "scan") void run(async () => {
      const result = await actions.invoke({ operation: "scan-current", ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }) });
      return { message: result.message, ...(result.jobId === undefined ? {} : { reference: result.jobId }) };
    });
    if (action === "sync") void run(async () => {
      const result = await actions.invoke({ operation: "sync-current", ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }), sessionId: current(), applySafe: true });
      return { message: result.message, ...(result.jobId ?? result.planId) === undefined ? {} : { reference: result.jobId ?? result.planId } };
    });
    if (action === "dashboard") void run(async () => ({ message: await openDashboard(actions, input.instanceId, current()) }));
    if (action === "save") void run(async () => {
      const settings: Record<string, unknown> = {};
      for (const name of PANEL_FIELDS) {
        const field = panel.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${name}"]`)!;
        settings[name] = field instanceof HTMLInputElement && field.type === "checkbox" ? field.checked
          : field instanceof HTMLInputElement && field.type === "number" ? Number(field.value)
            : field.value === "" ? null : field.value;
      }
      const result = await actions.invoke({ operation: "settings:patch", settings });
      return { message: result.message };
    });
  };
  panel.addEventListener("click", click);
  return {
    element: backdrop,
    open: () => { backdrop.hidden = false; void hydrate(); },
    close: () => { backdrop.hidden = true; },
    dispose: () => { panel.removeEventListener("click", click); backdrop.remove(); },
  };
}
