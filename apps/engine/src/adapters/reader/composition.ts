import { readRc1CanonicalEventText } from '@linmu/dsh-session-adapter-rc1';
import { readCodexCanonicalEventText } from '@linmu/dsh-adapter-codex-read';
import type { SessionReaderProvider } from '../../session-reader-port.js';
import { SessionReaderQueries } from './queries.js';
export const nativeReaderProvider: SessionReaderProvider = {
  create: database => new SessionReaderQueries(database),
  text: event => event.source.platform === 'dsh' ? readRc1CanonicalEventText(event as never)
    : event.source.platform === 'codex' ? readCodexCanonicalEventText(event) : typeof event.content === 'string' ? event.content : null,
};
