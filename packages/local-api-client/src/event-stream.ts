import { jobEventSchema, type JobEvent } from "@linmu/dsh-session-contracts";

export async function* decodeJobEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<JobEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const item = await reader.read();
      buffer += decoder.decode(item.value, { stream: !item.done });
      let boundary = /\r?\n\r?\n/u.exec(buffer);
      while (boundary !== null) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = block.split(/\r?\n/u);
        const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (data) {
          const event = jobEventSchema.parse(JSON.parse(data)) as JobEvent;
          const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
          if (id !== undefined && Number.parseInt(id, 10) !== event.sequence) {
            throw new TypeError("SSE event id does not match its persisted sequence");
          }
          yield event;
        }
        boundary = /\r?\n\r?\n/u.exec(buffer);
      }
      if (item.done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
