import type { ServerResponse } from "node:http";

import type { JobEvent, StatusEventQuery, StatusEventV1 } from "@linmu/dsh-session-contracts";
import type { StatusLog } from "@linmu/dsh-session-status-log";

import type { JobStore } from "../jobs/job-store.js";

export async function streamJobEvents(
  response: ServerResponse,
  store: JobStore,
  jobId: string,
  after: number,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  response.once("finish", () => controller.abort());
  for await (const event of store.subscribe(jobId, after, controller.signal)) {
    if (controller.signal.aborted || response.writableEnded || response.destroyed) break;
    response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event satisfies JobEvent)}\n\n`);
  }
  if (!response.writableEnded) response.end();
}

export async function streamStatusEvents(
  response: ServerResponse,
  log: StatusLog,
  query: StatusEventQuery,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.flushHeaders();
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  response.once("finish", () => controller.abort());
  for await (const event of log.subscribe(query, controller.signal)) {
    if (controller.signal.aborted || response.writableEnded || response.destroyed) break;
    response.write(`id: ${event.id}\nevent: status\ndata: ${JSON.stringify(event satisfies StatusEventV1)}\n\n`);
  }
  if (!response.writableEnded) response.end();
}
