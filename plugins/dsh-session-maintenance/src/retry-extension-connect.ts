/** Retry only registration, never replay business writes. One in-flight attempt per lifetime. */
export function retryExtensionConnect(connect: (signal: AbortSignal) => Promise<void>, report: () => void, delay = 5000): () => void {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async () => {
    try { await connect(abort.signal); }
    catch { if (!abort.signal.aborted) { report(); timer = setTimeout(() => void attempt(), delay); timer.unref?.(); } }
  };
  void attempt();
  return () => { abort.abort(); if (timer) clearTimeout(timer); };
}
