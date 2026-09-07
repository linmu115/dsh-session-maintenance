import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DashboardClient } from "@linmu/dsh-session-maintenance-client";
import "@linmu/dsh-session-ui/styles.css";

import { DashboardApp, DashboardOffline } from "./app.js";
import { applyDashboardAppearance, readDashboardAppearance } from "./appearance.js";
import "./dashboard.css";

applyDashboardAppearance(readDashboardAppearance());
const element = document.getElementById("root");
if (element === null) throw new TypeError("Dashboard root is missing");
const root = createRoot(element);
void DashboardClient.connect({ origin: window.location.origin }).then(
  (client) => root.render(<StrictMode><DashboardApp
    api={client}
    {...(client.initialLogicalSessionId === undefined ? {} : { initialLogicalSessionId: client.initialLogicalSessionId })}
  /></StrictMode>),
  () => root.render(<StrictMode><DashboardOffline /></StrictMode>),
);
