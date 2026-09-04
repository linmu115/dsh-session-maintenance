import type { Page, StatusEventQuery, StatusEventV1 } from "@linmu/dsh-session-contracts";
import type { SqliteStatusEventRepository } from "@linmu/dsh-session-store";

import { StatusEventBroadcaster } from "./memory-adapter.js";
import type { StatusEventAdapter } from "./status-log.js";

export class SqliteStatusEventAdapter implements StatusEventAdapter {
  readonly repository: SqliteStatusEventRepository;
  private readonly broadcaster = new StatusEventBroadcaster();
  private readonly publishedIds = new Set<string>();

  constructor(repository: SqliteStatusEventRepository) {
    this.repository = repository;
  }

  async append(input: StatusEventV1): Promise<void> {
    await this.repository.appendStatusEvent(input);
    if (this.publishedIds.has(input.id)) return;
    this.publishedIds.add(input.id);
    this.broadcaster.publish(input);
  }

  list(query: StatusEventQuery): Promise<Page<StatusEventV1>> {
    return this.repository.listStatusEvents(query);
  }

  subscribe(query: StatusEventQuery, signal?: AbortSignal): AsyncIterable<StatusEventV1> {
    return this.broadcaster.subscribe(query, signal);
  }
}
