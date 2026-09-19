import { createRoot } from "react-dom/client";
import { SessionMaintenanceSettingsSection } from "../../../../plugins/dsh-session-maintenance/src/client/settings-actions.js";
import { installStyles } from "../../../../plugins/dsh-session-maintenance/src/client/styles.js";
installStyles();
createRoot(document.getElementById("root")!).render(<SessionMaintenanceSettingsSection
  actions={{invoke: async () => { throw new Error("合成验收：此页面不连接真实维护引擎。"); }}}
  currentSessionId={() => undefined}
/>);
