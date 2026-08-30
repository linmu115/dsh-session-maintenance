import { describe, expect, it, vi } from "vitest";

import type { ClientSlots, MaintenanceActions, SettingsSectionRegistration } from "../src/client/context.js";
import { PANEL_FIELDS, registerSettingsSection, SETTINGS_SECTION_REGISTRATION } from "../src/client/settings-actions.js";
import { ENTRY_STYLES } from "../src/client/styles.js";

describe("native DSH settings section", () => {
  it("contains registered IDs and policies but no filesystem roots or capability", () => {
    expect(PANEL_FIELDS).toContain("codexInstanceId");
    expect(PANEL_FIELDS).toContain("dshInstanceId");
    expect(PANEL_FIELDS).toContain("workspaceMappingId");
    expect(PANEL_FIELDS).not.toContain("root" as never);
    expect(JSON.stringify(PANEL_FIELDS)).not.toMatch(/token|capability|path|home/iu);
  });

  it("registers through the official settings.section slot and disposes with the plugin fiber", () => {
    let registration: SettingsSectionRegistration | undefined;
    let component: unknown;
    const dispose = vi.fn();
    const slots: ClientSlots = {
      inject: vi.fn((_name: "settings.section", callback: () => () => void) => callback()),
      register: vi.fn((value: SettingsSectionRegistration, registeredComponent: unknown) => {
        registration = value;
        component = registeredComponent;
        return dispose;
      }),
    };
    const actions: MaintenanceActions = { invoke: vi.fn() };
    const release = registerSettingsSection(slots, { actions, currentSessionId: () => "session-1" });

    expect(slots.inject).toHaveBeenCalledWith("settings.section", expect.any(Function));
    expect(registration).toMatchObject(SETTINGS_SECTION_REGISTRATION);
    expect(typeof registration?.inject).toBe("function");
    expect(component).toEqual(expect.any(Function));
    release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not ship the retired bottom-right launcher or modal overlay styles", () => {
    expect(ENTRY_STYLES).not.toContain("dsm-entry-launch");
    expect(ENTRY_STYLES).not.toContain("dsm-entry-backdrop");
    expect(ENTRY_STYLES).toContain("dsm-settings-section");
  });
});
