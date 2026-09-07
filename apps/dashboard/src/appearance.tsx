import { useLayoutEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type DashboardAppearance = "light" | "dark" | "system";
const preferenceKey = "dsh-maintenance.appearance";

export function readDashboardAppearance(): DashboardAppearance {
  try {
    const value = window.localStorage.getItem(preferenceKey);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch { /* Private or restricted browser storage must not block reading. */ }
  return "light";
}

export function applyDashboardAppearance(value: DashboardAppearance): void {
  document.documentElement.dataset.dsmAppearance = value;
}

/** Appearance stays local to this browser and never changes Engine settings. */
export function DashboardAppearanceControl() {
  const [appearance, setAppearance] = useState(readDashboardAppearance);
  useLayoutEffect(() => applyDashboardAppearance(appearance), [appearance]);
  const Icon = appearance === "dark" ? Moon : appearance === "system" ? Monitor : Sun;
  return <label className="dashboard-appearance">
    <Icon size={15} aria-hidden="true" /><span>外观</span>
    <select aria-label="外观" value={appearance} onChange={(event) => {
      const value = event.currentTarget.value;
      if (value !== "light" && value !== "dark" && value !== "system") return;
      setAppearance(value);
      try { window.localStorage.setItem(preferenceKey, value); } catch { /* Keep the current choice usable without persistence. */ }
    }}>
      <option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option>
    </select>
  </label>;
}
