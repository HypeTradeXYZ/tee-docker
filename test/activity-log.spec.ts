import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog } from '../src/observability/activity-log.service';
import type { ActivityConfig } from '../src/observability/activity-config';

function makeConfig(over: Partial<ActivityConfig> = {}): ActivityConfig {
  return {
    enabled: true,
    eventCap: 2000,
    perfCap: 900,
    perfIntervalMs: 1000,
    maxFieldLen: 256,
    crashDump: true,
    crashDumpEvents: 1000,
    crashDumpFile: join(tmpdir(), 'unused-activity-crash.json'),
    ...over,
  };
}

describe('ActivityLog ring', () => {
  it('assigns a monotonic seq, drops oldest past the cap, and counts drops', () => {
    const log = new ActivityLog(makeConfig({ enabled: true, eventCap: 3 }));
    for (let i = 0; i < 5; i += 1) log.emit('request', { n: i });
    const events = log.recent();
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(log.stats()).toMatchObject({ eventsCaptured: 5, eventsDropped: 2, eventsHeld: 3, lastSeq: 5 });
  });

  it('returns only events strictly after sinceSeq, filtered by kind', () => {
    const log = new ActivityLog(makeConfig());
    log.emit('request', { a: 1 });
    log.emit('error', { code: 'x' });
    log.emit('request', { a: 2 });
    expect(log.recent({ sinceSeq: 1 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(log.recent({ kind: 'error' }).map((e) => e.code)).toEqual(['x']);
  });

  it('ignores everything while disabled', () => {
    const log = new ActivityLog(makeConfig({ enabled: false }));
    log.emit('request', { a: 1 });
    expect(log.recent()).toHaveLength(0);
    expect(log.stats().enabled).toBe(false);
  });
});

describe('ActivityLog redaction at capture', () => {
  // Synthetic token fixtures — each proves the scrubber strips that shape.
  const cases: Array<[string, string, RegExp]> = [
    ['bearer', 'Bearer abc.def.ghi', /Bearer <redacted>/],
    ['jwt', 'eyJhbGciOi.eyJzdWIiOi.sIgNaTuRe', /<jwt>/],
    ['api key', 'sk-ant-0123456789abcdef', /<api-key>/], // allow-redaction: synthetic scrubber fixture
    ['github token', 'ghp_0123456789abcdef0123', /<token>/], // allow-redaction: synthetic scrubber fixture
    ['private key', `0x${'a'.repeat(64)}`, /<hex-secret>/],
  ];
  it.each(cases)('scrubs a %s before it enters the ring', (_label, raw, expected) => {
    const log = new ActivityLog(makeConfig());
    log.emit('request', { field: raw });
    const stored = String(log.recent()[0]!.field);
    expect(stored).toMatch(expected);
    expect(stored).not.toContain(raw);
  });

  it('keeps a 40-hex wallet address and ordinary reason strings intact', () => {
    const log = new ActivityLog(makeConfig());
    const address = `0x${'b'.repeat(40)}`;
    log.emit('session', { address, reason: 'no token lifetime remains', code: 'session_expired' });
    expect(log.recent()[0]).toMatchObject({
      address,
      reason: 'no token lifetime remains',
      code: 'session_expired',
    });
  });

  it('caps overlong fields to maxFieldLen', () => {
    const log = new ActivityLog(makeConfig({ maxFieldLen: 10 }));
    log.emit('request', { note: 'x'.repeat(50) });
    expect(String(log.recent()[0]!.note)).toHaveLength(10);
  });
});

describe('ActivityLog crash dump', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'activity-crash-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flushes a bounded 0600 tail and reloads it into the lastcrash scope', () => {
    const cfg = makeConfig({ crashDumpFile: join(dir, 'activity-crash.json'), crashDumpEvents: 2 });
    const a = new ActivityLog(cfg);
    a.emit('error', { code: 'session_expired', reason: 'no token lifetime remains' });
    a.emit('request', { route: '/v1/auth/token', status: 401 });
    a.emit('request', { route: '/v1/quota', status: 200 });
    a.flushToDisk('uncaughtException');

    expect(statSync(cfg.crashDumpFile).mode & 0o777).toBe(0o600);

    const b = new ActivityLog(cfg);
    b.onModuleInit();
    const crash = b.recent({ scope: 'lastcrash' });
    expect(crash).toHaveLength(2); // bounded to crashDumpEvents
    expect(b.recent({ scope: 'current' })).toHaveLength(0);
    expect(b.stats().lastCrashHeld).toBe(2);
    b.onModuleDestroy();
  });

  it('degrades to an empty lastcrash on a corrupt dump', () => {
    const cfg = makeConfig({ crashDumpFile: join(dir, 'activity-crash.json') });
    writeFileSync(cfg.crashDumpFile, '{ not json');
    const log = new ActivityLog(cfg);
    log.onModuleInit();
    expect(log.recent({ scope: 'lastcrash' })).toHaveLength(0);
    log.onModuleDestroy();
  });

  it('never throws from flushToDisk when the path is unwritable', () => {
    const cfg = makeConfig({ crashDumpFile: join(dir, 'no-such-subdir', 'x.json') });
    const log = new ActivityLog(cfg);
    log.emit('request', { a: 1 });
    expect(() => log.flushToDisk('shutdown')).not.toThrow();
  });
});

describe('ActivityLog perf sampler', () => {
  it('produces timestamped samples on its interval', async () => {
    const log = new ActivityLog(makeConfig({ perfIntervalMs: 20 }));
    log.onModuleInit();
    await new Promise((r) => setTimeout(r, 70));
    const samples = log.perfSamples();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]).toHaveProperty('loopLagMeanMs');
    expect(samples[0]).toHaveProperty('rssBytes');
    log.onModuleDestroy();
  });
});
