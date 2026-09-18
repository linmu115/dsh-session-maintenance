import { expect, it, vi } from 'vitest';
import { retryExtensionConnect } from '../src/retry-extension-connect.js';
it('recovers Engine-after-host registration without replaying business actions and stops after disposal', async () => {
  vi.useFakeTimers();
  const connect = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const report = vi.fn(); const stop = retryExtensionConnect(connect, report);
  try { await vi.advanceTimersByTimeAsync(0); expect(report).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(5000); expect(connect).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(15000); expect(connect).toHaveBeenCalledTimes(2); }
  finally { stop(); vi.useRealTimers(); }
  expect(connect.mock.calls[0]![0].aborted).toBe(true);
});
it('does not retry after disposal during a failed request', async () => {
  vi.useFakeTimers(); const connect = vi.fn().mockRejectedValue(new Error('offline')); const stop = retryExtensionConnect(connect, vi.fn()); stop(); await vi.advanceTimersByTimeAsync(10000); expect(connect).toHaveBeenCalledOnce(); vi.useRealTimers();
});
