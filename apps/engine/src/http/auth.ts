import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") && equalSecret(header.slice(7), token);
}

export function allowedOrigin(request: IncomingMessage, origin: string): boolean {
  const value = request.headers.origin;
  return value === undefined || value === origin;
}
