import type { DatabaseSync } from 'node:sqlite';
import type { CanonicalEventV1, ReaderEventPage, ReaderEventQuery, ReaderProcessPage, ReaderProcessQuery, SessionReaderPage, SessionReaderQuery } from '@linmu/dsh-session-contracts';
export interface SessionReaderPort {
  snapshot(sessionId: string, expected?: string): string;
  event(sessionId: string, eventId: string, query: ReaderEventQuery): ReaderEventPage;
  page(sessionId: string, query: SessionReaderQuery): Pick<SessionReaderPage, 'schemaVersion' | 'snapshot' | 'turns' | 'nextCursor'>;
  process(sessionId: string, query: ReaderProcessQuery): ReaderProcessPage;
}
export interface SessionReaderProvider {
  create(database: DatabaseSync): SessionReaderPort;
  text(event: CanonicalEventV1): string | null;
}
