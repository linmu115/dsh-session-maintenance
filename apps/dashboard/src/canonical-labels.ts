import type { SessionOriginKind } from "@linmu/dsh-session-contracts";

export function canonicalOriginLabel(origin: SessionOriginKind): string {
  if (origin === "codex-mirror") return "Codex 同步";
  if (origin === "codex-derived") return "Codex 派生";
  return "Maintenance 原生";
}
