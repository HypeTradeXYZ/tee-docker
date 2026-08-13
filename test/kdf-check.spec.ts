import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  KDF_CHECK_CONFIG,
  KDF_PROBE_RUNNER,
  KdfCheckService,
  assessKdfProbe,
  createKdfProbeRunner,
  kdfCheckConfigFromEnv,
  systemKdfProbeRunner,
  type KdfCheckConfig,
  type KdfProbeObservation,
  type KdfProbeRunner,
  type KdfProbeIo,
} from '../src/kdf/kdf-check.service';

const productionConfig: KdfCheckConfig = {
  nodeEnv: 'production',
  maxProbeMs: 1_000,
  allowUnsafe: false,
};

describe('KDF readiness configuration', () => {
  it('uses safe defaults', () => {
    expect(kdfCheckConfigFromEnv({})).toEqual({
      nodeEnv: 'development', maxProbeMs: 1_000, allowUnsafe: false,
    });
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '60001'])(
    'rejects invalid threshold %p',
    (value) => expect(() => kdfCheckConfigFromEnv({
      TEE_KDF_MAX_PROBE_MS: value,
    })).toThrow('TEE_KDF_MAX_PROBE_MS'),
  );

  it('accepts the threshold boundaries', () => {
    expect(kdfCheckConfigFromEnv({ TEE_KDF_MAX_PROBE_MS: '1' }).maxProbeMs).toBe(1);
    expect(kdfCheckConfigFromEnv({ TEE_KDF_MAX_PROBE_MS: '60000' }).maxProbeMs).toBe(60_000);
  });

  it.each(['true', 'yes', '01', ' 1', 'FALSE'])(
    'rejects unsafe acknowledgement typo %p',
    (value) => expect(() => kdfCheckConfigFromEnv({
      TEE_ALLOW_UNSAFE_KDF: value,
    })).toThrow('TEE_ALLOW_UNSAFE_KDF'),
  );

  it('requires migration from the old quiet bypass', () => {
    expect(() => kdfCheckConfigFromEnv({ TEE_SKIP_KDF_CHECK: '1' }))
      .toThrow('TEE_SKIP_KDF_CHECK was removed');
  });
});

describe('KDF probe assessment', () => {
  it('observes the installed 2.4.4 native provider backend', async () => {
    const observation = await systemKdfProbeRunner();
    expect(observation.backends).toEqual(['node-rs']);
    expect(Number.isFinite(observation.probeMs)).toBe(true);
    expect(observation.probeMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [['node-rs'], 999, true, undefined],
    [['node-rs'], 1_000, true, undefined],
    [['wasm'], 10, false, 'backend_unsafe'],
    [['noble'], 10, false, 'backend_unsafe'],
    [['unresolved'], 10, false, 'backend_unsafe'],
    [['future-native'], 10, false, 'backend_unsafe'],
    [['node-rs', 'wasm'], 10, false, 'backend_unsafe'],
    [[], 10, false, 'backend_unsafe'],
    [[1], 10, false, 'backend_unsafe'],
    [['node-rs'], 1_001, false, 'probe_slow'],
    [['node-rs'], Number.NaN, false, 'probe_slow'],
    [['node-rs'], Number.POSITIVE_INFINITY, false, 'probe_slow'],
    [['node-rs'], -1, false, 'probe_slow'],
  ] as const)('classifies %p at %pms', (backends, probeMs, safe, reason) => {
    expect(assessKdfProbe({ backends, probeMs }, 1_000)).toMatchObject({ safe, reason });
  });
});

describe('KDF probe runner cleanup', () => {
  function fixture(overrides: Partial<KdfProbeIo> = {}) {
    const lock = jest.fn(async () => undefined);
    const io: KdfProbeIo = {
      createTemp: jest.fn(() => '/tmp/kdf-probe-fixture'),
      open: jest.fn(async () => ({ lock })),
      backendInfo: jest.fn(() => ({ backend: 'unresolved', overrides: ['node-rs'] })),
      now: jest.fn()
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(20),
      remove: jest.fn(),
      ...overrides,
    };
    return { io, lock, run: createKdfProbeRunner(io) };
  }

  it('reports the authoritative override and removes its temporary directory', async () => {
    const { io, lock, run } = fixture();
    await expect(run()).resolves.toEqual({ backends: ['node-rs'], probeMs: 10 });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(io.remove).toHaveBeenCalledWith('/tmp/kdf-probe-fixture');
  });

  it.each(['open', 'lock', 'report', 'clock', 'remove'] as const)(
    'rejects and still attempts cleanup when %s fails',
    async (stage) => {
      const cleanupLock = jest.fn(async () => undefined);
      let clockCalls = 0;
      const { io, run } = fixture({
        open: stage === 'open'
          ? jest.fn(async () => { throw new Error('SECRET open'); })
          : jest.fn(async () => ({
            lock: stage === 'lock'
              ? jest.fn()
                .mockRejectedValueOnce(new Error('SECRET lock'))
                .mockImplementation(cleanupLock)
              : cleanupLock,
          })),
        backendInfo: stage === 'report'
          ? jest.fn(() => { throw new Error('SECRET report'); })
          : jest.fn(() => ({ backend: 'unresolved', overrides: ['node-rs'] })),
        now: stage === 'clock'
          ? jest.fn(() => {
            clockCalls += 1;
            if (clockCalls === 2) throw new Error('SECRET clock');
            return 10;
          })
          : jest.fn().mockReturnValueOnce(10).mockReturnValueOnce(20),
        remove: stage === 'remove'
          ? jest.fn(() => { throw new Error('SECRET remove'); })
          : jest.fn(),
      });
      await expect(run()).rejects.toBeInstanceOf(AggregateError);
      expect(io.remove).toHaveBeenCalledWith('/tmp/kdf-probe-fixture');
      if (stage === 'lock') expect(cleanupLock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, {}, { backend: 'node-rs' }, { backend: 1, overrides: [] }, {
    backend: 'unresolved', overrides: [1],
  }])('rejects malformed backend report %p', async (report) => {
    const { run } = fixture({ backendInfo: jest.fn(() => report) });
    await expect(run()).rejects.toBeInstanceOf(AggregateError);
  });
});

describe('KdfCheckService boot enforcement', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  async function init(
    runProbe: KdfProbeRunner,
    config: KdfCheckConfig = productionConfig,
  ) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: KDF_CHECK_CONFIG, useValue: config },
        { provide: KDF_PROBE_RUNNER, useValue: runProbe },
        KdfCheckService,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    try {
      await app.init();
      return { app, service: app.get(KdfCheckService) };
    } catch (caught) {
      await app.close();
      throw caught;
    }
  }

  async function createApp(
    runProbe: KdfProbeRunner,
    config: KdfCheckConfig = productionConfig,
  ) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: KDF_CHECK_CONFIG, useValue: config },
        { provide: KDF_PROBE_RUNNER, useValue: runProbe },
        KdfCheckService,
      ],
    }).compile();
    return moduleRef.createNestApplication();
  }

  it('accepts the exact native backend before serving', async () => {
    const { app, service } = await init(async () => ({ backends: ['node-rs'], probeMs: 100 }));
    expect(service.status).toEqual({
      backends: ['node-rs'], safe: true, probeMs: 100, reason: undefined,
    });
    await app.close();
  });

  it.each([
    [{ backends: ['wasm'], probeMs: 50 }],
    [{ backends: ['node-rs'], probeMs: 1_001 }],
  ] as Array<[KdfProbeObservation]>)('refuses an unsafe observation %p', async (result) => {
    await expect(init(async () => result)).rejects.toMatchObject({
      code: 'TEE_KDF_BACKEND_UNSAFE',
    });
  });

  it('fails closed without logging the probe exception', async () => {
    await expect(init(async () => {
      throw new Error('SECRET /private/path');
    })).rejects.toMatchObject({ code: 'TEE_KDF_BACKEND_UNSAFE' });
    expect(error).toHaveBeenCalledWith('KDF readiness check failed (probe_failed); refusing startup');
    expect(JSON.stringify(error.mock.calls)).not.toContain('SECRET');
  });

  it('rejects listen before the HTTP adapter binds', async () => {
    const app = await createApp(async () => ({ backends: ['wasm'], probeMs: 1 }));
    await expect(app.listen(0, '127.0.0.1')).rejects.toMatchObject({
      code: 'TEE_KDF_BACKEND_UNSAFE',
    });
    expect(app.getHttpServer().listening).toBe(false);
    await app.close();
  });

  it('runs and records the probe under explicit unsafe acknowledgement', async () => {
    const probe = jest.fn(async () => ({ backends: ['wasm'], probeMs: 200 }));
    const { app, service } = await init(probe, { ...productionConfig, allowUnsafe: true });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(service.status).toMatchObject({ safe: false, reason: 'backend_unsafe' });
    expect(warn).toHaveBeenCalledWith('UNSAFE KDF ACCEPTED BY OPERATOR (backend_unsafe)');
    await app.close();
  });

  it('skips before invoking the runner only in exact test mode', async () => {
    const probe = jest.fn(async () => ({ backends: ['wasm'], probeMs: 1 }));
    const { app, service } = await init(probe, { ...productionConfig, nodeEnv: 'test' });
    expect(probe).not.toHaveBeenCalled();
    expect(service.status).toBeNull();
    await app.close();
  });
});
