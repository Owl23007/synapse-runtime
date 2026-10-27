/** 等待可取消操作，迟到的结果只被消费，不再推进调用方状态 */
export function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("运行已取消"));
    signal.addEventListener("abort", aborted, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted))
      .catch(() => undefined);
    if (signal.aborted) aborted();
  });
}

/** 有界 FIFO 执行队列，未入队的请求不被视为已接受 */
export class ExecutionGate {
  #active = 0;
  #rejected = 0;
  #closed = false;
  readonly #queue: { start: () => void; reject: (error: Error) => void }[] = [];
  /** 固定实例并发与等待容量，零等待容量表示繁忙时立即拒绝 */
  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 0)
      throw new Error("运行并发或队列容量无效");
  }
  /** 返回容量快照供管理界面解释拥塞 */
  get status() {
    return {
      active: this.#active,
      queued: this.#queue.length,
      rejected: this.#rejected,
      maxConcurrent: this.concurrency,
      maxQueued: this.maxQueued
    };
  }
  /** 执行或排队，调用结束才释放名额 */
  run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.#closed || (this.#active >= this.concurrency && this.#queue.length >= this.maxQueued)) {
        this.#rejected++;
        reject(new Error(this.#closed ? "Runtime 正在关闭，未接受请求" : "Runtime 运行队列已满，未接受请求"));
        return;
      }
      const start = () => {
        this.#active++;
        void Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            this.#active--;
            this.#queue.shift()?.start();
          });
      };
      if (this.#active < this.concurrency) start();
      else this.#queue.push({ start, reject });
    });
  }
  /** 关闭接单并拒绝尚未开始的排队请求，已经接受的运行由宿主收尾 */
  close(): void {
    this.#closed = true;
    for (const item of this.#queue.splice(0)) item.reject(new Error("Runtime 已关闭，排队请求未执行"));
  }
}
