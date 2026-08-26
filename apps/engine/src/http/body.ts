import type { IncomingMessage } from "node:http";

export const MAX_BODY_BYTES = 64 * 1024;

export class HttpBodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new HttpBodyError(413, "Request body exceeds 64 KiB");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new HttpBodyError(400, "Malformed JSON body");
  }
}
