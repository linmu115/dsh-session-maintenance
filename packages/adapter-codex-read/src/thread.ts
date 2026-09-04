import type { CodexThreadRow } from "./parser.js";

const MAX_CODEX_DISPLAY_TITLE = 96;

function compactTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function extractDelegatedInput(value: string): string | undefined {
  const match = /<input>([\s\S]*?)<\/input>/iu.exec(value);
  return match?.[1] === undefined ? undefined : compactTitle(match[1]);
}

function extractUserRequest(value: string): string | undefined {
  const match = /(?:^|\n)## My request:\s*\n?([\s\S]+)$/iu.exec(value);
  return match?.[1] === undefined ? undefined : compactTitle(match[1]);
}

function extractContinuationTitle(value: string): string | undefined {
  if (!/^# DSH continuation context\b/iu.test(value.trimStart())) return undefined;
  const match = /(?:^|\n)Title:\s*([^\r\n]+)/iu.exec(value);
  return match?.[1] === undefined ? undefined : compactTitle(match[1]);
}

function extractTitleBeforeRuntimeDiagnostics(value: string): string | undefined {
  const lines = value.split(/\r?\n/gu).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return undefined;
  const diagnostic = /^\[(?:info|stderr|stdout|error|warn(?:ing)?)\]\b|^(?:fatal|error|warning):\s/iu;
  return lines.slice(1).some((line) => diagnostic.test(line))
    ? compactTitle(lines[0]!)
    : undefined;
}

function boundedTitle(value: string): string {
  const points = [...value];
  return points.length <= MAX_CODEX_DISPLAY_TITLE
    ? value
    : `${points.slice(0, MAX_CODEX_DISPLAY_TITLE - 1).join("")}…`;
}

/** Uses Codex's user-facing task name and prevents raw prompts from becoming sidebar labels. */
export function codexDisplayTitle(row: Pick<CodexThreadRow, "id" | "name" | "title">): string {
  const name = row.name === null ? "" : compactTitle(row.name);
  if (name.length > 0) return boundedTitle(name);
  const raw = row.title.trim();
  const candidate = extractDelegatedInput(raw)
    ?? extractUserRequest(raw)
    ?? extractContinuationTitle(raw)
    ?? extractTitleBeforeRuntimeDiagnostics(raw)
    ?? compactTitle(raw.replace(/<[^>]+>/gu, " "));
  if (candidate.length > 0) return boundedTitle(candidate);
  return `未命名会话 · ${row.id.slice(0, 8)}`;
}

function parsedThreadSource(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex records Guardian approval assessors and spawned workers in the same
 * table as user-owned tasks. They are implementation detail threads and must
 * never become independent Maintenance sessions. A user-visible delegated task
 * remains eligible because Codex publishes it with a normal `vscode` source.
 */
export function isUserFacingCodexThread(
  row: Pick<CodexThreadRow, "source" | "agent_role">,
): boolean {
  const source = parsedThreadSource(row.source);
  return source?.subagent === undefined && row.agent_role === null;
}
