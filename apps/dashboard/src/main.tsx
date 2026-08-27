import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { MaintenanceClient } from "@linmu/dsh-session-maintenance-client";
import "@linmu/dsh-session-ui/styles.css";

import { DashboardApp, DashboardOffline } from "./app.js";
import "./dashboard.css";
import { takeRuntimeConnection } from "./runtime.js";

const element = document.getElementById("root");
if (element === null) throw new TypeError("Dashboard root is missing");
const connection = takeRuntimeConnection();
createRoot(element).render(<StrictMode>
  {connection === undefined
    ? <DashboardOffline />
    : <DashboardApp api={new MaintenanceClient(connection)} />}
</StrictMode>);
