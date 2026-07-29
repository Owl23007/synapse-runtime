import type { ChannelAdapter, ChannelRegistry } from "./types.js";

/**
 * 频道适配器注册表的内存实现
 */
export class InMemoryChannelRegistry implements ChannelRegistry {
  readonly #adapters = new Map<string, ChannelAdapter>();

  /** 注册频道适配器 */
  register(adapter: ChannelAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Channel adapter "${adapter.id}" is already registered.`);
    }

    this.#adapters.set(adapter.id, adapter);
  }

  /** 注销并返回频道适配器 */
  unregister(channelId: string): ChannelAdapter | undefined {
    const adapter = this.#adapters.get(channelId);

    if (adapter !== undefined) {
      this.#adapters.delete(channelId);
    }

    return adapter;
  }

  /** 按频道标识读取适配器 */
  get(channelId: string): ChannelAdapter | undefined {
    return this.#adapters.get(channelId);
  }

  /** 列出全部频道适配器 */
  list(): readonly ChannelAdapter[] {
    return [...this.#adapters.values()];
  }
}
