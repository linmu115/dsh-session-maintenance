import type { ServerResponse } from "node:http";

import type { JobEvent } from "@linmu/dsh-session-contracts";

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
  for await (const event of store.subscribe(jobId, after, controller.signal)) {
    response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event satisfies JobEvent)}\n\n`);
  }
  response.end();
}
