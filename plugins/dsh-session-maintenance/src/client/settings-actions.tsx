import { useEffect, useState } from "react";

import type { ClientSlots, MaintenanceActions } from "./context.js";
import { openDashboard } from "./dashboard-entry.js";

export const PANEL_FIELDS = [
  "codexInstanceId", "dshInstanceId", "workspaceMappingId", "syncSingleSidedTitle", "scanScope", "backupRetention", "allowBatchSafeApply",
] as const;

export const SETTINGS_SECTION_REGISTRATION = {
  name: "settings.section",
  id: "session-maintenance",
  order: 90,
  label: "会话维护",
} as const;

export interface ActionFeedback { readonly message: string; readonly reference?: string }

interface MaintenanceSettingsDraft {
  readonly codexInstanceId: string;
  readonly dshInstanceId: string;
  readonly workspaceMappingId: string;
  readonly syncSingleSidedTitle: boolean;
  readonly scanScope: "current" | "registered";
  readonly backupRetention: number;
  readonly allowBatchSafeApply: boolean;
}

export interface SettingsSectionProps {
  readonly actions: MaintenanceActions;
  readonly instanceId?: string;
  readonly currentSessionId: () => string | undefined;
}

const DEFAULT_SETTINGS: MaintenanceSettingsDraft = {
  codexInstanceId: "",
  dshInstanceId: "",
  workspaceMappingId: "",
  syncSingleSidedTitle: true,
  scanScope: "current",
  backupRetention: 20,
  allowBatchSafeApply: false,
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function settingsDraft(value: unknown): MaintenanceSettingsDraft {
  const settings = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const backupRetention = typeof settings.backupRetention === "number" && Number.isInteger(settings.backupRetention)
    ? settings.backupRetention
    : DEFAULT_SETTINGS.backupRetention;
  return {
    codexInstanceId: stringValue(settings.codexInstanceId),
    dshInstanceId: stringValue(settings.dshInstanceId),
    workspaceMappingId: stringValue(settings.workspaceMappingId),
    syncSingleSidedTitle: settings.syncSingleSidedTitle !== false,
    scanScope: settings.scanScope === "registered" ? "registered" : "current",
    backupRetention: Math.min(10_000, Math.max(1, backupRetention)),
    allowBatchSafeApply: settings.allowBatchSafeApply === true,
  };
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function messageOf(value: ActionFeedback): string {
  return value.reference === undefined ? value.message : `${value.message} · ${value.reference}`;
}

export function SessionMaintenanceSettingsSection(props: SettingsSectionProps) {
  const [draft, setDraft] = useState<MaintenanceSettingsDraft>(DEFAULT_SETTINGS);
  const [feedback, setFeedback] = useState("正在读取维护参数…");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const hydrate = async (active: () => boolean = () => true) => {
    try {
      const result = await props.actions.invoke({ operation: "settings:get" });
      if (!active()) return;
      setDraft(settingsDraft(result.settings));
      setLoaded(true);
      setFeedback("维护参数已读取");
    } catch (error) {
      if (!active()) return;
      setLoaded(false);
      setFeedback(error instanceof Error ? error.message : "无法读取维护参数");
    }
  };

  useEffect(() => {
    let active = true;
    void hydrate(() => active);
    return () => { active = false; };
  }, [props.actions]);

  const run = async (work: () => Promise<ActionFeedback>) => {
    if (busy) return;
    setBusy(true);
    setFeedback("正在执行…");
    try { setFeedback(messageOf(await work())); }
    catch (error) { setFeedback(error instanceof Error ? error.message : "维护操作失败"); }
    finally { setBusy(false); }
  };

  const currentSessionId = () => {
    const sessionId = props.currentSessionId();
    if (sessionId === undefined) throw new Error("当前没有打开的 DSH 会话");
    return sessionId;
  };

  const patch = <K extends keyof MaintenanceSettingsDraft>(key: K, value: MaintenanceSettingsDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <section className="dsm-settings-section" aria-label="会话维护设置">
      <p className="dsm-settings-intro">管理 Codex 与 DSH 会话映射、同步策略和本地会话维护引擎。</p>

      <div className="dsm-settings-group">
        <h3>实例与同步</h3>
        <label className="dsm-settings-field">
          <span><strong>Codex 实例 ID</strong><small>留空时使用引擎当前登记。</small></span>
          <input value={draft.codexInstanceId} onChange={(event) => { patch("codexInstanceId", event.currentTarget.value); }} />
        </label>
        <label className="dsm-settings-field">
          <span><strong>DSH 实例 ID</strong><small>选择本次操作对应的官方 DSH profile。</small></span>
          <input value={draft.dshInstanceId} onChange={(event) => { patch("dshInstanceId", event.currentTarget.value); }} />
        </label>
        <label className="dsm-settings-field">
          <span><strong>工作区映射 ID</strong><small>可选的稳定工作区对应关系。</small></span>
          <input value={draft.workspaceMappingId} onChange={(event) => { patch("workspaceMappingId", event.currentTarget.value); }} />
        </label>
        <label className="dsm-settings-field">
          <span><strong>扫描范围</strong><small>当前登记或全部已登记实例。</small></span>
          <select value={draft.scanScope} onChange={(event) => { patch("scanScope", event.currentTarget.value === "registered" ? "registered" : "current"); }}>
            <option value="current">当前登记</option>
            <option value="registered">全部登记实例</option>
          </select>
        </label>
        <label className="dsm-settings-field">
          <span><strong>备份保留事务数</strong><small>允许范围为 1–10000。</small></span>
          <input type="number" min={1} max={10_000} value={draft.backupRetention} onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            patch("backupRetention", Number.isFinite(value) ? value : 1);
          }} />
        </label>
        <label className="dsm-settings-toggle">
          <input type="checkbox" checked={draft.syncSingleSidedTitle} onChange={(event) => { patch("syncSingleSidedTitle", event.currentTarget.checked); }} />
          <span><strong>同步单边标题变化</strong><small>仅一侧改名时，将标题同步到另一侧。</small></span>
        </label>
        <label className="dsm-settings-toggle">
          <input type="checkbox" checked={draft.allowBatchSafeApply} onChange={(event) => { patch("allowBatchSafeApply", event.currentTarget.checked); }} />
          <span><strong>允许批量应用安全计划</strong><small>只应用引擎判定为无需人工确认的计划。</small></span>
        </label>
      </div>

      <div className="dsm-settings-group">
        <h3>操作</h3>
        <div className="dsm-settings-actions">
          <button type="button" className="dsm-primary" disabled={busy || !loaded} onClick={() => { void run(async () => {
            const result = await props.actions.invoke({
              operation: "settings:patch",
              settings: {
                codexInstanceId: nullable(draft.codexInstanceId),
                dshInstanceId: nullable(draft.dshInstanceId),
                workspaceMappingId: nullable(draft.workspaceMappingId),
                syncSingleSidedTitle: draft.syncSingleSidedTitle,
                scanScope: draft.scanScope,
                backupRetention: Math.min(10_000, Math.max(1, Math.trunc(draft.backupRetention))),
                allowBatchSafeApply: draft.allowBatchSafeApply,
              },
            });
            setDraft(settingsDraft(result.settings));
            return { message: result.message };
          }); }}>保存参数</button>
          <button type="button" disabled={busy} onClick={() => { void run(async () => {
            const result = await props.actions.invoke({ operation: "scan-current", ...(props.instanceId === undefined ? {} : { instanceId: props.instanceId }) });
            return { message: result.message, ...(result.jobId === undefined ? {} : { reference: result.jobId }) };
          }); }}>扫描已登记会话</button>
          <button type="button" disabled={busy} onClick={() => { void run(async () => {
            const result = await props.actions.invoke({
              operation: "sync-current",
              ...(props.instanceId === undefined ? {} : { instanceId: props.instanceId }),
              sessionId: currentSessionId(),
              applySafe: true,
            });
            const reference = result.jobId ?? result.planId;
            return { message: result.message, ...(reference === undefined ? {} : { reference }) };
          }); }}>同步当前会话</button>
          <button type="button" disabled={busy} onClick={() => { void run(async () => ({
            message: await openDashboard(props.actions, props.instanceId),
          })); }}>打开完整看板</button>
          <button type="button" disabled={busy} onClick={() => { void hydrate(); }}>重新读取参数</button>
        </div>
        <output className="dsm-settings-feedback" aria-live="polite">{feedback}</output>
      </div>
    </section>
  );
}

export function registerSettingsSection(slots: ClientSlots, props: SettingsSectionProps): () => void {
  return slots.inject("settings.section", () => slots.register({
    ...SETTINGS_SECTION_REGISTRATION,
    inject: () => ({ ...props }),
  }, SessionMaintenanceSettingsSection));
}
