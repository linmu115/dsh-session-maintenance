import type { CanonicalDashboardSessionDetail } from "./http.js";

/** Read-only UI semantics. These never alter canonical roles or model exposure. */
export type ReaderProcessKind = "runtime-context" | "skill-catalog" | "plugin-context" | "tool-call" | "tool-result" | "reasoning" | "record" | "assistant" | "opaque-data";
export interface ReaderMessage {
  readonly eventId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly totalChars: number;
  readonly nextOffset: number | null;
}
export interface ReaderTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly messages: readonly ReaderMessage[];
  readonly processCount: number;
  readonly processKinds: readonly { readonly kind: ReaderProcessKind; readonly label: string; readonly count: number }[];
}
export interface SessionReaderPage {
  readonly schemaVersion: 1;
  readonly detail: Omit<CanonicalDashboardSessionDetail, "events">;
  /** Binds pages to the same canonical head and event directory revision. */
  readonly snapshot: string;
  readonly turns: readonly ReaderTurn[];
  readonly nextCursor: string | null;
}
export interface ReaderProcessItem {
  readonly id: string;
  readonly kind: ReaderProcessKind;
  readonly label: string;
  readonly eventIds: readonly string[];
  readonly paired: boolean;
}
export interface ReaderProcessPage {
  readonly schemaVersion: 1;
  readonly snapshot: string;
  readonly turnId: string;
  readonly items: readonly ReaderProcessItem[];
  readonly nextCursor: string | null;
}
export interface ReaderEventPage {
  readonly schemaVersion: 1;
  readonly snapshot: string;
  readonly eventId: string;
  readonly format: "text" | "raw";
  readonly text: string;
  /** Unicode code-point offsets (matching SQLite substr), not UTF-16 indexes. */
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset: number | null;
}
export interface SessionReaderQuery { readonly snapshot?: string | undefined; readonly cursor?: string | undefined; readonly limit?: number | undefined }
export interface ReaderProcessQuery { readonly snapshot: string; readonly turnId: string; readonly cursor?: string | undefined; readonly limit?: number | undefined }
export interface ReaderEventQuery { readonly snapshot: string; readonly format?: "text" | "raw" | undefined; readonly offset?: number | undefined; readonly limit?: number | undefined }
export interface SessionReaderApi {
  getSessionReader(id: string, query?: SessionReaderQuery, signal?: AbortSignal): Promise<SessionReaderPage>;
  getSessionReaderProcess(id: string, query: ReaderProcessQuery, signal?: AbortSignal): Promise<ReaderProcessPage>;
  getSessionReaderEvent(id: string, eventId: string, query: ReaderEventQuery, signal?: AbortSignal): Promise<ReaderEventPage>;
}
