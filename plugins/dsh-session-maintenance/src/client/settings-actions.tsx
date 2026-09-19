import { useState } from "react";

import type { ClientSlots, MaintenanceActions } from "./context.js";
import { openDashboard } from "./dashboard-entry.js";

export const SETTINGS_SECTION_REGISTRATION = {
  name: "settings.section",
  id: "session-maintenance",
  order: 90,
  label: "会话维护",
} as const;

export interface SettingsSectionProps {
  readonly actions: MaintenanceActions;
  readonly instanceId?: string;
  readonly currentSessionId: () => string | undefined;
}

export function SessionMaintenanceSettingsSection(props: SettingsSectionProps) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback("正在打开看板…");
    try { setFeedback(await openDashboard(props.actions, props.instanceId)); }
    catch (error) { setFeedback(error instanceof Error ? error.message : "无法打开会话维护看板"); }
    finally { setBusy(false); }
  };

  return (
    <section className="dsm-settings-section" aria-label="会话维护设置">
      <p className="dsm-settings-intro">在完整看板中管理会话、同步范围和 Vault 绑定。</p>
      <div className="dsm-settings-actions">
        <button type="button" className="dsm-primary" disabled={busy} onClick={() => { void open(); }}>打开完整看板</button>
      </div>
      {feedback ? <output className="dsm-settings-feedback" aria-live="polite">{feedback}</output> : null}
    </section>
  );
}

export function registerSettingsSection(slots: ClientSlots, props: SettingsSectionProps): () => void {
  return slots.inject("settings.section", () => slots.register({
    ...SETTINGS_SECTION_REGISTRATION,
    inject: () => ({ ...props }),
  }, SessionMaintenanceSettingsSection));
}
