import { sha256Canonical } from "./canonical-json.js";

export function normalizeWorkspacePath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const separators = trimmed.replaceAll("/", "\\").replace(/\\+$/u, "");
  if (separators.length === 0) return null;
  return /^[A-Za-z]:\\/u.test(separators) ? separators.toLocaleLowerCase("en-US") : separators;
}

export function workspaceIdFromPath(value: string): string | null {
  const normalized = normalizeWorkspacePath(value);
  return normalized === null ? null : `workspace_${sha256Canonical(normalized).slice(0, 24)}`;
}

export function workspaceLabelFromPath(value: string): string | null {
  const normalized = value.trim().replace(/[\\/]+$/u, "");
  if (normalized.length === 0) return null;
  const segments = normalized.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? normalized;
}
