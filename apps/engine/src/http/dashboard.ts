import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

const ASSET = /^\/dashboard\/assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/u;

export const DASHBOARD_CANONICAL_MIGRATION_PREVIEW_PATH = "/v1/migrations/canonical/preview";
export const DASHBOARD_CANONICAL_WORKSPACES_PATH = "/v1/canonical/workspaces";
export const DASHBOARD_CANONICAL_PROJECTS_PATH = "/v1/canonical/projects";

function headers(response: ServerResponse, contentType: string, cacheControl: string): void {
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", cacheControl);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

function mediaType(name: string): string {
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export async function serveDashboardAsset(
  request: IncomingMessage,
  response: ServerResponse,
  dashboardRoot: string,
): Promise<boolean> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/dashboard") {
    response.statusCode = 308;
    response.setHeader("location", "/dashboard/");
    response.setHeader("cache-control", "no-store");
    response.end();
    return true;
  }
  let file: string;
  let contentType: string;
  let cacheControl: string;
  if (path === "/dashboard/") {
    file = join(dashboardRoot, "index.html");
    contentType = "text/html; charset=utf-8";
    cacheControl = "no-store";
  } else {
    const match = ASSET.exec(path);
    if (match === null) return false;
    file = join(dashboardRoot, "assets", match[1]!);
    contentType = mediaType(match[1]!);
    cacheControl = "public, max-age=31536000, immutable";
  }
  try {
    const body = await readFile(file);
    response.statusCode = 200;
    headers(response, contentType, cacheControl);
    response.setHeader("content-length", String(body.byteLength));
    response.end(method === "HEAD" ? undefined : body);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    response.statusCode = code === "ENOENT" ? 404 : 500;
    headers(response, "application/json; charset=utf-8", "no-store");
    response.end(JSON.stringify({ error: { code: code === "ENOENT" ? "NOT_FOUND" : "DASHBOARD_ASSET_ERROR" } }));
  }
  return true;
}
