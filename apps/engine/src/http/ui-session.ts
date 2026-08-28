import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const COOKIE_NAME = "dsh_maintenance_ui";

interface LaunchEntry { readonly expiresAt: number; readonly logicalSessionId?: string }
interface SessionEntry { readonly csrfToken: string; readonly expiresAt: number; readonly initialLogicalSessionId?: string }

export interface DashboardLaunch {
  readonly code: string;
  readonly url: string;
  readonly expiresAt: string;
}

export interface ClaimedUiSession {
  readonly cookie: string;
  readonly expiresAt: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function cookieValue(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie;
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

export function hasUiSessionCookie(request: IncomingMessage): boolean {
  return cookieValue(request) !== undefined;
}

function exactUiOrigin(request: IncomingMessage, origin: string): boolean {
  const expected = new URL(origin);
  if (request.headers.host !== expected.host) return false;
  if (request.headers.origin !== undefined) return request.headers.origin === origin;
  if (request.headers["sec-fetch-site"] !== "same-origin") return false;
  const referer = request.headers.referer;
  // The dashboard deliberately sends Referrer-Policy: no-referrer so its
  // browser bootstrap has no Referer. Fetch Metadata plus the exact loopback
  // Host still proves that the request came from the dashboard origin.
  if (referer === undefined) return true;
  try { return new URL(referer).origin === origin; } catch { return false; }
}

export class UiSessionManager {
  private readonly launches = new Map<string, LaunchEntry>();
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly launchTtlMs = 60_000,
    private readonly sessionTtlMs = 15 * 60_000,
  ) {}

  issue(origin: string, logicalSessionId?: string): DashboardLaunch {
    this.prune();
    const code = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.launchTtlMs;
    this.launches.set(digest(code), { expiresAt, ...(logicalSessionId === undefined ? {} : { logicalSessionId }) });
    return {
      code,
      url: `${origin}/ui/claim?code=${encodeURIComponent(code)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  claim(code: string): ClaimedUiSession | undefined {
    this.prune();
    const key = digest(code);
    const launch = this.launches.get(key);
    this.launches.delete(key);
    if (launch === undefined || launch.expiresAt <= this.now()) return undefined;
    const id = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(digest(id), {
      csrfToken: randomBytes(32).toString("base64url"),
      expiresAt,
      ...(launch.logicalSessionId === undefined ? {} : { initialLogicalSessionId: launch.logicalSessionId }),
    });
    return {
      cookie: `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  session(request: IncomingMessage, origin: string): SessionEntry | undefined {
    this.prune();
    if (!exactUiOrigin(request, origin)) return undefined;
    const id = cookieValue(request);
    if (id === undefined) return undefined;
    const session = this.sessions.get(digest(id));
    return session?.expiresAt !== undefined && session.expiresAt > this.now() ? session : undefined;
  }

  authorized(request: IncomingMessage, origin: string, requireCsrf = true): boolean {
    const session = this.session(request, origin);
    if (session === undefined) return false;
    if (!requireCsrf) return true;
    const csrf = request.headers["x-dsh-csrf"];
    return typeof csrf === "string" && equalSecret(csrf, session.csrfToken);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.launches) if (value.expiresAt <= now) this.launches.delete(key);
    for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key);
  }
}
