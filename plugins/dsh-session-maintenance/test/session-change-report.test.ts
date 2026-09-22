import { describe, expect, it, vi } from 'vitest';
import { observeSessions, reportSessionChanges, sessionSyncIntents, type SessionObservation } from '../src/client/session-change-report.js';

/**
 * The instance side reporting its own archive/delete changes, with the timing the operator set:
 * only while the Engine is reachable, and only for sessions this instance has mapped.
 */
const observation = (rows: readonly [string, boolean][]): SessionObservation =>
  new Map(rows.map(([id, archived]) => [id, { sessionId: id, archived }]));

describe('observing the host session list', () => {
  it('reads an array list and marks archive state from the id map', () => {
    const observed = observeSessions({ items: [{ id: 'a' }, { id: 'b' }], byId: { b: { archived: true } } } as never);
    expect(observed.get('a')).toEqual({ sessionId: 'a', archived: false });
    expect(observed.get('b')).toEqual({ sessionId: 'b', archived: true });
  });

  it('reads a bare array list without inventing archive state', () => {
    const observed = observeSessions([{ id: 'a' }, { id: 'b', archived: true }] as never);
    expect(observed.get('a')?.archived).toBe(false);
    expect(observed.get('b')?.archived).toBe(true);
  });
});

describe('diffing two observations', () => {
  it('reports a vanished session as a deletion and an archive flip as an archive', () => {
    const intents = sessionSyncIntents(observation([['a', false], ['b', false], ['c', true]]), observation([['a', true], ['c', false]]));
    // Intents follow the previous observation's order, so the sequence is stable across runs.
    expect(intents).toEqual([
      { kind: 'archive', sessionId: 'a' },
      { kind: 'delete', sessionId: 'b' },
      { kind: 'archive', sessionId: 'c' },
    ]);
  });

  it('does not report a new local session, which the source learns by import instead', () => {
    expect(sessionSyncIntents(observation([['a', false]]), observation([['a', false], ['new', false]]))).toEqual([]);
  });
});

describe('reporting changes', () => {
  const input = (over: Partial<Parameters<typeof reportSessionChanges>[0]> = {}) => ({
    engineReady: async () => true,
    mapped: async () => true,
    report: vi.fn(async (intent: { kind: string; sessionId: string }) => `reported ${intent.kind} ${intent.sessionId}`),
    onFeedback: vi.fn(),
    ...over,
  });

  it('sends nothing while the Engine is not reachable, because the next start overwrites instead', async () => {
    const i = input({ engineReady: async () => false });
    expect(await reportSessionChanges(i, [{ kind: 'delete', sessionId: 'a' }])).toBe(0);
    expect(i.report).not.toHaveBeenCalled();
  });

  it('never pushes a session this instance has not mapped', async () => {
    const i = input({ mapped: async id => id !== 'unmapped' });
    const reported = await reportSessionChanges(i, [{ kind: 'delete', sessionId: 'unmapped' }, { kind: 'archive', sessionId: 'mapped' }]);
    expect(reported).toBe(1);
    expect(i.report).toHaveBeenCalledTimes(1);
    expect(i.report).toHaveBeenCalledWith({ kind: 'archive', sessionId: 'mapped' });
  });

  it('reports a refusal instead of throwing, so the sidebar keeps working', async () => {
    const i = input({ report: vi.fn(async () => { throw new Error('真源拒绝'); }) });
    expect(await reportSessionChanges(i, [{ kind: 'delete', sessionId: 'a' }])).toBe(0);
    expect(i.onFeedback).toHaveBeenCalledWith('真源拒绝');
  });
});
