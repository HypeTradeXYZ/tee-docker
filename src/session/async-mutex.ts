/** A small FIFO mutex whose queue survives a rejecting task. */
export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => gate);

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Lazily allocates per-key mutexes and drops them after the last waiter. */
export class KeyedMutex {
  readonly #slots = new Map<string, { mutex: AsyncMutex; users: number }>();

  async runExclusive<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const slot = this.#slots.get(key) ?? { mutex: new AsyncMutex(), users: 0 };
    slot.users += 1;
    this.#slots.set(key, slot);
    try {
      return await slot.mutex.runExclusive(fn);
    } finally {
      slot.users -= 1;
      if (slot.users === 0 && this.#slots.get(key) === slot) this.#slots.delete(key);
    }
  }
}
