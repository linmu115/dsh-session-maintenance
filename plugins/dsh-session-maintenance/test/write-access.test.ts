import { expect, it, vi } from 'vitest';
import { RegisteredSessionWriteAccess } from '../src/write-access.js';

it('blocks offline writes and only resumes after pending work and a second readiness check', async () => {
  let online = false, reconciled = false;
  const access = new RegisteredSessionWriteAccess(async () => { if (!online) throw new Error('offline'); }, async () => { reconciled = true; });
  await expect(access.assertWritable()).rejects.toThrow('草稿与未确认数据已保留');
  expect(reconciled).toBe(false);
  online = true; await access.assertWritable();
  expect(reconciled).toBe(true); expect(access.snapshot().state).toBe('ready');
  online = false; await expect(access.assertWritable()).rejects.toThrow();
  expect(access.snapshot().state).toBe('paused');
});
it('keeps writes paused if recovery fails and never treats a closed gate as independent mode', async () => {
  const access = new RegisteredSessionWriteAccess(async () => {}, async () => { throw new Error('unconfirmed append'); });
  await expect(access.assertWritable()).rejects.toThrow();
  expect(access.snapshot().state).toBe('paused');
  access.close(); await expect(access.assertWritable()).rejects.toThrow('关闭');
});
it('coalesces concurrent checks and cannot reopen if shutdown occurs during recovery', async () => {
  let finish!: () => void;
  const reconcile = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const access = new RegisteredSessionWriteAccess(async () => {}, reconcile);
  const first = access.assertWritable(), second = access.assertWritable();
  const results = Promise.allSettled([first, second]);
  await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
  expect(first).toBe(second); access.close(); finish();
  expect((await results).every(result => result.status === 'rejected')).toBe(true);
  expect(access.snapshot().state).toBe('closed');
});
