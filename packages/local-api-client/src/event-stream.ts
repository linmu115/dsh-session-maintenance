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
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (data) yield jobEventSchema.parse(JSON.parse(data)) as JobEvent;
        boundary = buffer.indexOf("\n\n");
      }
      if (item.done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
