import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import {
  jobEventSchema,
  jobRefSchema,
  type JobEvent,
  type JobRef,
  type JobRequest,
  type JsonValue,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

interface JobRow {
  readonly id: string;
  readonly status: JobRef["status"];
  readonly request_json: string;
  readonly result_json: string | null;
}

interface EventRow { readonly event_json: string }

type JobEventInput =
  | { readonly type: "queued" | "running" }
  | { readonly type: "progress"; readonly current: number; readonly total?: number; readonly message: string }
  | { readonly type: "completed"; readonly result: JsonValue }
  | { readonly type: "failed"; readonly code: string; readonly message: string };

export interface StoredJob {
  readonly ref: JobRef;
  readonly request: JobRequest;
  readonly result?: JsonValue;
}

export class JobStore {
  private readonly events = new EventEmitter();

  constructor(readonly database: DatabaseSync, private readonly clock: () => string = () => new Date().toISOString()) {}

  createScan(instanceIds: readonly string[]): JobRef {
    return this.create({ kind: "scan", instanceIds });
  }

  createApply(planId: string): JobRef {
    return this.create({ kind: "apply", planId });
  }

  createRestore(transactionId: string): JobRef {
    return this.create({ kind: "restore", transactionId });
  }

  createRecover(transactionId: string): JobRef {
    return this.create({ kind: "recover", transactionId });
  }

  private create(request: JobRequest): JobRef {
    const id = `job_${randomUUID().replaceAll("-", "")}`;
    const now = this.clock();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "INSERT INTO jobs (id, status, request_json, result_json, created_at, updated_at) VALUES (?, 'queued', ?, NULL, ?, ?)",
      ).run(id, canonicalJson(request as unknown as JsonValue), now, now);
      this.insertEvent({ jobId: id, sequence: 0, at: now, type: "queued" });
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    }
    this.events.emit(id);
    return { id, status: "queued" };
  }

  get(id: string): StoredJob | undefined {
    const row = this.database.prepare(
      "SELECT id, status, request_json, result_json FROM jobs WHERE id = ?",
    ).get(id) as JobRow | undefined;
    if (row === undefined) return undefined;
    const ref = jobRefSchema.parse({ id: row.id, status: row.status }) as JobRef;
    const request = JSON.parse(row.request_json) as StoredJob["request"];
    return {
      ref,
      request,
      ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as JsonValue }),
    };
  }

  recoverable(): readonly StoredJob[] {
    const rows = this.database.prepare(
      "SELECT id, status, request_json, result_json FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at, id",
    ).all() as unknown as JobRow[];
    return rows.map((row) => this.get(row.id)!);
  }

  markRunning(id: string): void {
    this.transition(id, "running", { type: "running" });
  }

  markRequeued(id: string): void {
    this.transition(id, "queued", { type: "queued" });
  }

  progress(id: string, current: number, total: number | undefined, message: string): void {
    this.append(id, {
      type: "progress",
      current,
      ...(total === undefined ? {} : { total }),
      message,
    });
  }

  complete(id: string, result: JsonValue): void {
    this.transition(id, "completed", { type: "completed", result }, result);
  }

  fail(id: string, code: string, message: string): void {
    this.transition(id, "failed", { type: "failed", code, message }, { code, message });
  }

  listEvents(id: string, after = -1): readonly JobEvent[] {
    const rows = this.database.prepare(
      "SELECT event_json FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence",
    ).all(id, after) as unknown as EventRow[];
    return rows.map((row) => jobEventSchema.parse(JSON.parse(row.event_json)) as JobEvent);
  }

  async *subscribe(id: string, after = -1, signal?: AbortSignal): AsyncIterable<JobEvent> {
    let cursor = after;
    while (!signal?.aborted) {
      const events = this.listEvents(id, cursor);
      for (const event of events) {
        cursor = event.sequence;
        yield event;
        if (event.type === "completed" || event.type === "failed") return;
      }
      if (this.get(id) === undefined) return;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timeout); signal?.removeEventListener("abort", done); resolve(); };
        const timeout = setTimeout(done, 30_000);
        this.events.once(id, done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  private transition(
    id: string,
    status: JobRef["status"],
    event: JobEventInput,
    result?: JsonValue,
  ): void {
    const now = this.clock();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE jobs SET status = ?, result_json = ?, updated_at = ? WHERE id = ?")
        .run(status, result === undefined ? null : canonicalJson(result), now, id);
      this.insertEvent({ ...event, jobId: id, sequence: this.nextSequence(id), at: now } as JobEvent);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    }
    this.events.emit(id);
  }

  private append(id: string, event: JobEventInput): void {
    const value = { ...event, jobId: id, sequence: this.nextSequence(id), at: this.clock() } as JobEvent;
    this.insertEvent(value);
    this.events.emit(id);
  }

  private nextSequence(id: string): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM job_events WHERE job_id = ?")
      .get(id) as unknown as { readonly sequence: number };
    return row.sequence;
  }

  private insertEvent(event: JobEvent): void {
    jobEventSchema.parse(event);
    this.database.prepare(
      "INSERT INTO job_events (job_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(event.jobId, event.sequence, canonicalJson(event as unknown as JsonValue), event.at);
  }
}
