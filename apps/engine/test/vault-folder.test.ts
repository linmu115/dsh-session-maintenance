import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { execFile } from 'node:child_process';
import { createWindowsVaultFolderPicker } from '../src/vault-folder.js';
import { FOLDER_PICKER_READY } from '../src/vault-folder-script.js';

afterEach(() => vi.useRealTimers());
function helper() {
  const stderr = new PassThrough();
  let finish: (error: Error | null, stdout: string) => void;
  let signal: AbortSignal;
  const launch = vi.fn((_file, _args, options, callback) => {
    finish = callback;
    signal = options.signal;
    signal.addEventListener('abort', () => callback(new Error('aborted'), ''), { once: true });
    return { stderr };
  });
  return {
    launch,
    picker: createWindowsVaultFolderPicker({ platform: 'win32', execute: launch as unknown as typeof execFile }),
    finish: (output: string, error: Error | null = null) => finish(error, output),
    ready: () => { stderr.write(FOLDER_PICKER_READY.slice(0, 9)); stderr.write(FOLDER_PICKER_READY.slice(9) + '\r\n'); },
    aborted: () => signal.aborted,
  };
}
it('bounds helper startup and aborts it when the shell never becomes ready', async () => {
  vi.useFakeTimers(); const h = helper();
  const result = expect(h.picker(new AbortController().signal)).rejects.toThrow('未能及时打开');
  await vi.advanceTimersByTimeAsync(20_000);
  await result; expect(h.aborted()).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('allows time to choose after readiness, without extending the deadline on folder navigation', async () => {
  vi.useFakeTimers(); const h = helper(); const promise = h.picker(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(19_000); h.ready();
  await vi.advanceTimersByTimeAsync(61_000); expect(h.aborted()).toBe(false); h.ready();
  const result = expect(promise).rejects.toThrow('等待超时');
  await vi.advanceTimersByTimeAsync(539_000); await result;
  expect(h.aborted()).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it.each(['opening', 'selecting'])('aborts only its helper when the request disconnects during %s', async stage => {
  vi.useFakeTimers(); const h = helper(); const controller = new AbortController();
  const promise = h.picker(controller.signal); if (stage === 'selecting') h.ready();
  const result = expect(promise).rejects.toThrow('已取消'); controller.abort(); await result;
  expect(h.aborted()).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it.each([null, 'C:\\合成 Vault\\notes'])('returns cancellation or a Unicode path without evaluating it (%s)', async path => {
  vi.useFakeTimers(); const h = helper(); const promise = h.picker(new AbortController().signal);
  h.ready(); h.finish(JSON.stringify({ path }));
  await expect(promise).resolves.toBe(path); expect(vi.getTimerCount()).toBe(0);
  expect(h.launch.mock.calls[0]![1]).toContain('-EncodedCommand');
  expect(h.launch.mock.calls[0]![2]).toMatchObject({ windowsHide: true });
});
it.each(['not json', '{"path":""}', '{"path":123}', '{"path":null,"extra":true}'])('rejects invalid output without leaking its content', async output => {
  const h = helper(); const promise = h.picker(new AbortController().signal); h.finish(output);
  await expect(promise).rejects.toThrow('文件夹选择结果无效');
});
it('does not expose a helper error or launch for an already aborted caller', async () => {
  const h = helper(); const promise = h.picker(new AbortController().signal);
  h.finish('', new Error('private-path-canary')); await expect(promise).rejects.toThrow('无法打开');
  const controller = new AbortController(); controller.abort();
  await expect(h.picker(controller.signal)).rejects.toThrow(); expect(h.launch).toHaveBeenCalledTimes(1);
});
