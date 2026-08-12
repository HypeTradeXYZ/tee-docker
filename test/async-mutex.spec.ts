import { AsyncMutex, KeyedMutex } from '../src/session/async-mutex';

describe('AsyncMutex', () => {
  it('serializes callers in arrival order and survives rejection', async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = mutex.runExclusive(async () => {
      events.push('first-enter');
      await barrier;
      events.push('first-exit');
      throw new Error('probe');
    });
    const second = mutex.runExclusive(() => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first-enter']);
    release();
    await expect(first).rejects.toThrow('probe');
    await second;
    expect(events).toEqual(['first-enter', 'first-exit', 'second']);
  });
});

describe('KeyedMutex', () => {
  it('serializes one key while allowing different keys to progress', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const a1 = mutex.runExclusive('a', async () => {
      events.push('a1');
      await barrier;
    });
    const a2 = mutex.runExclusive('a', () => events.push('a2'));
    const b = mutex.runExclusive('b', () => events.push('b'));

    await Promise.resolve();
    await b;
    expect(events).toEqual(['a1', 'b']);
    release();
    await Promise.all([a1, a2]);
    expect(events).toEqual(['a1', 'b', 'a2']);
  });
});
