import { createHash } from "node:crypto";

const contract = {
  platformVersion: "0.146.0",
  protocol: "app-server-v2",
  requiredRequests: ["initialize", "thread/start", "turn/start", "thread/read", "thread/resume"],
  requiredNotifications: ["turn/completed"],
  historyMode: "paginated",
} as const;

export const CODEX_CONTINUATION_CONTRACT = contract;
export const CODEX_CONTINUATION_SCHEMA_FINGERPRINT =
  `codex-continuation/${contract.platformVersion}/${contract.protocol}:` +
  createHash("sha256").update(JSON.stringify(contract)).digest("hex");
