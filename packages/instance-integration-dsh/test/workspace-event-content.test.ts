import { expect, it } from 'vitest';
import { canonicalEventsFor } from '../src/instance-workspace-source.js';

it('keeps readable native content, attribution and opaque plugin payloads when joining or appending a workspace', () => {
  const events = [
    { seq: 0, time: 1, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic question' }] } },
    { seq: 1, time: 2, type: 'context/checkpoint', data: { key: 'checkpoint', state: { nested: [false, null, 42] } } },
  ];
  const rows = canonicalEventsFor({ artifact: { nativeSessionId: 'synthetic', header: {}, inheritedEventCount: 0, events } as never,
    instanceId: 'synthetic-host', logicalSessionId: () => 'logical-synthetic' });
  expect(rows[0]).toMatchObject({ kind: 'user-message', content: events[0]!.data, rawPayload: events[0],
    extensions: { dshEventType: 'user/message', nativeFormatVersion: 3 } });
  expect(rows[1]).toMatchObject({ content: events[1]!.data, rawPayload: events[1],
    extensions: { extensionNamespace: 'gpt-compat', extensionDataType: 'context/checkpoint' } });
});
