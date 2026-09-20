/** Runtime policy, independent of business adapters and their data formats. */
export class RegisteredSessionWriteAccess {
  readonly protocolVersion = 1;
  private state: 'paused' | 'recovering' | 'ready' | 'closed' = 'paused';
  private checking: Promise<void> | undefined;
  private error: string | null = null;
  constructor(private readonly probe: () => Promise<void>, private readonly reconcile: () => Promise<void>) {}
  snapshot() { return { registered: true, state: this.state, error: this.error }; }
  assertWritable(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new Error('实例正在关闭，已暂停新的发送和修改'));
    if (this.checking) return this.checking;
    const work = (async () => {
      try {
        await this.probe();
        if (this.snapshot().state === 'closed') throw new Error('实例正在关闭');
        this.state = 'recovering';
        await this.reconcile();
        // Recovery can overlap another outage; verify again before admitting writes.
        await this.probe();
        if (this.snapshot().state === 'closed') throw new Error('实例正在关闭');
        this.state = 'ready'; this.error = null;
      } catch (error) {
        if (this.state !== 'closed') this.state = 'paused';
        this.error = '此实例已接入 Maintenance，维护服务未就绪或尚有未完成操作；请恢复服务后重试。草稿与未确认数据已保留。';
        throw new Error(this.error, { cause: error });
      }
    })();
    this.checking = work;
    void work.finally(() => { if (this.checking === work) this.checking = undefined; }).catch(() => {});
    return work;
  }
  close() { this.state = 'closed'; }
}
