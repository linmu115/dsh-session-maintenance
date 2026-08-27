export interface RuntimeConnection {
  readonly origin: string;
  readonly token: string;
}

declare global {
  interface Window {
    __DSH_SESSION_MAINTENANCE__?: RuntimeConnection;
  }
}

function valid(value: unknown): value is RuntimeConnection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeConnection>;
  return typeof candidate.origin === "string"
    && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(candidate.origin)
    && typeof candidate.token === "string"
    && candidate.token.length >= 32;
}

export function takeRuntimeConnection(): RuntimeConnection | undefined {
  const value = window.__DSH_SESSION_MAINTENANCE__;
  delete window.__DSH_SESSION_MAINTENANCE__;
  return valid(value) ? value : undefined;
}
