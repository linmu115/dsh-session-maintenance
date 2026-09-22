import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { CanonicalDashboardEvent } from '@linmu/dsh-session-contracts';
import { CanonicalEventList } from '../src/canonical-event-view.js';

it('maps opaque events into one closed bundle without inspecting or serializing their structures', () => {
  const events = [0, 1].map(sequence => ({ id: `unknown-${sequence}`, logicalSessionId: 'one', kind: 'opaque-unknown', sequence,
    get content() { throw new Error('Opaque body must not be inspected by rendering'); },
    get rawPayload() { throw new Error('Opaque raw body must not be inspected by rendering'); },
  } as unknown as CanonicalDashboardEvent));
  const html = renderToStaticMarkup(createElement(CanonicalEventList, { events }));
  expect(html.match(/<details>/g)).toHaveLength(1);
  expect(html).toContain('未识别数据包（2 条）');
  expect(html).not.toContain('open='); expect(html).not.toContain('<pre');
});
