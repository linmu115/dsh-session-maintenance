import { statusEventV1Schema } from "@linmu/dsh-session-contracts";
import type {
  Page,
  StatusEventQuery,
  StatusEventV1,
} from "@linmu/dsh-session-contracts";

import { statusEventMatches, type StatusEventAdapter } from "./status-log.js";

type Listener = (event: StatusEventV1) => void;

export class StatusEventBroadcaster {
  private readonly listeners = new Set<Listener>();

  publish(event: StatusEventV1): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(query: StatusEventQuery, signal?: AbortSignal): AsyncIterable<StatusEventV1> {
    const listeners = this.listeners;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: StatusEventV1[] = [];
        let wake: (() => void) | undefined;
        const listener: Listener = (event) => {
          if (!statusEventMatches(event, query)) return;
          queue.push(event);
          wake?.();
          wake = undefined;
        };
        const abort = (): void => {
          wake?.();
          wake = undefined;
        };
        listeners.add(listener);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          while (signal?.aborted !== true) {
            const event = queue.shift();
            if (event !== undefined) {
              yield event;
              continue;
            }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        } finally {
          listeners.delete(listener);
          signal?.removeEventListener("abort", abort);
        }
      },
    };
  }
}

export class MemoryStatusEventAdapter implements StatusEventAdapter {
  private readonly events: StatusEventV1[] = [];
  private readonly broadcaster = new StatusEventBroadcaster();

  async append(input: StatusEventV1): Promise<void> {
    statusEventV1Schema.parse(input);
    const existing = this.events.find((event) => event.id === input.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) {
        throw new Error(`Status event ID already has different content: ${input.id}`);
      }
      return;
    }
    this.events.push(input);
    this.events.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
    this.broadcaster.publish(input);
  }

  async list(query: StatusEventQuery): Promise<Page<StatusEventV1>> {
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError(`Invalid status event cursor: ${query.cursor}`);
    const limit = query.limit ?? 50;
    const filtered = this.events.filter((event) => statusEventMatches(event, query));
    return {
      items: filtered.slice(offset, offset + limit),
      ...(offset + limit < filtered.length ? { nextCursor: String(offset + limit) } : {}),
    };
  }

  subscribe(query: StatusEventQuery, signal?: AbortSignal): AsyncIterable<StatusEventV1> {
    return this.broadcaster.subscribe(query, signal);
  }
}
