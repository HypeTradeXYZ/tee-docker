import { randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paths } from '../src/config/paths';
import {
  NODE_SERVICE_STATE_FS,
  ServiceStateService,
  type ServiceStateFs,
} from '../src/config/service-state.service';
import type { ServiceState } from '../src/config/schemas';

describe('ServiceStateService durable ledger', () => {
  let baseDir: string;
  let paths: Paths;
  let services: ServiceStateService[];

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'tee-state-test-'));
    const stateDir = join(baseDir, 'state');
    paths = {
      configDir: join(baseDir, 'config'),
      stateDir,
      dataRoot: join(baseDir, 'data'),
      tenantsFile: join(baseDir, 'config', 'tenants.json'),
      errorsFile: join(baseDir, 'config', 'errors.json'),
      stateFile: join(stateDir, 'state.json'),
    };
    services = [];
  });

  afterEach(async () => {
    for (const service of services.reverse()) {
      await service.close().catch(() => undefined);
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  function openState(fs: ServiceStateFs = NODE_SERVICE_STATE_FS): ServiceStateService {
    const service = ServiceStateService.fromFile(paths, fs);
    services.push(service);
    return service;
  }

  async function closeState(service: ServiceStateService): Promise<void> {
    await service.close();
    services = services.filter((candidate) => candidate !== service);
  }

  function stateWith(total: number): ServiceState {
    return {
      tenants: {
        acme: {
          walletTotal: total,
          workspaces: total === 0
            ? []
            : [{
                slug: 'desk-a',
                createdAt: '2026-08-12T00:00:00.000Z',
                walletCount: total,
              }],
        },
      },
    };
  }

  function stateWithNestedValues(): ServiceState {
    return {
      tenants: {
        acme: {
          walletTotal: 2,
          workspaces: [{
            slug: 'desk-a',
            createdAt: '2026-08-12T00:00:00.000Z',
            walletCount: 2,
          }],
          workspaceCooldowns: { 'desk-old': 1_900_000_000_000 },
          walletTagRecoveries: {
            'desk-a': {
              accountSlug: 'vault-a',
              walletId: 7,
              oldTags: ['primary', 'cold'],
            },
          },
        },
      },
    };
  }

  async function setTotal(service: ServiceStateService, total: number): Promise<void> {
    await service.mutate((draft) => {
      draft.tenants = stateWith(total).tenants;
    });
  }

  function readState(path = paths.stateFile): ServiceState {
    return JSON.parse(readFileSync(path, 'utf8')) as ServiceState;
  }

  it('durably initializes primary, backup, and marker with private modes', () => {
    const service = openState();

    expect(service.tenant('acme')).toEqual({ walletTotal: 0, workspaces: [] });
    expect(readState()).toEqual({ tenants: {} });
    expect(readState(`${paths.stateFile}.bak`)).toEqual({ tenants: {} });
    expect(readFileSync(`${paths.stateFile}.initialized`, 'utf8')).toBe(
      'tee-docker-state-v1\n',
    );
    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
    for (const path of [
      paths.stateFile,
      `${paths.stateFile}.bak`,
      `${paths.stateFile}.initialized`,
      `${paths.stateFile}.lock`,
    ]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('returns fresh deep tenant snapshots without a shared missing-tenant value', () => {
    const initial = stateWithNestedValues();
    const service = new ServiceStateService(paths, initial);
    const first = service.tenant('acme');
    const second = service.tenant('acme');

    expect(first).not.toBe(second);
    expect(first.workspaces).not.toBe(second.workspaces);
    expect(first.workspaces[0]).not.toBe(second.workspaces[0]);
    expect(first.workspaceCooldowns).not.toBe(second.workspaceCooldowns);
    expect(first.walletTagRecoveries).not.toBe(second.walletTagRecoveries);
    expect(first.walletTagRecoveries?.['desk-a']).not.toBe(
      second.walletTagRecoveries?.['desk-a'],
    );
    expect(first.walletTagRecoveries?.['desk-a']?.oldTags).not.toBe(
      second.walletTagRecoveries?.['desk-a']?.oldTags,
    );

    first.walletTotal = 99;
    first.workspaces[0].walletCount = 99;
    first.workspaces.push({
      slug: 'desk-b',
      createdAt: '2026-08-12T00:00:00.000Z',
      walletCount: 99,
    });
    first.workspaceCooldowns!['desk-old'] = 1;
    first.walletTagRecoveries!['desk-a'].oldTags.push('changed');
    delete first.walletTagRecoveries!['desk-a'];

    expect(service.tenant('acme')).toEqual(stateWithNestedValues().tenants.acme);

    const missingA = service.tenant('missing-a');
    const missingB = service.tenant('missing-b');
    expect(missingA).not.toBe(missingB);
    expect(missingA.workspaces).not.toBe(missingB.workspaces);
    missingA.walletTotal = 42;
    missingA.workspaces.push({
      slug: 'poison',
      createdAt: '2026-08-12T00:00:00.000Z',
      walletCount: 1,
    });
    expect(service.tenant('missing-a')).toEqual({ walletTotal: 0, workspaces: [] });
    expect(service.tenant('missing-b')).toEqual({ walletTotal: 0, workspaces: [] });
  });

  it('treats prototype-colliding tenant ids as own ledger keys', async () => {
    const service = openState();
    const first = service.tenant('constructor');
    const second = service.tenant('constructor');

    expect(first).toEqual({ walletTotal: 0, workspaces: [] });
    expect(second).toEqual({ walletTotal: 0, workspaces: [] });
    expect(first).not.toBe(second);
    first.walletTotal = 99;

    await service.mutate((draft) => {
      const tenantId: string = 'constructor';
      const tenant = Object.hasOwn(draft.tenants, tenantId)
        ? draft.tenants[tenantId]
        : (draft.tenants[tenantId] = { walletTotal: 0, workspaces: [] });
      tenant.workspaces.push({
        slug: 'desk-a',
        createdAt: '2026-08-12T00:00:00.000Z',
        walletCount: 1,
      });
      tenant.walletTotal = 1;
    });

    expect(Object.hasOwn(readState().tenants, 'constructor')).toBe(true);
    expect(service.tenant('constructor').walletTotal).toBe(1);
    await closeState(service);
    const reopened = openState();
    expect(reopened.tenant('constructor')).toEqual({
      walletTotal: 1,
      workspaces: [{
        slug: 'desk-a',
        createdAt: '2026-08-12T00:00:00.000Z',
        walletCount: 1,
      }],
    });
  });

  it('detaches constructor input, mutation results, and callback-retained drafts', async () => {
    const initial = stateWithNestedValues();
    const constructorService = new ServiceStateService(paths, initial);
    initial.tenants.acme.walletTotal = 77;
    initial.tenants.acme.workspaces[0].walletCount = 77;
    initial.tenants.acme.walletTagRecoveries!['desk-a'].oldTags.push('escaped');
    expect(constructorService.tenant('acme')).toEqual(stateWithNestedValues().tenants.acme);

    const service = openState();
    let retainedDraft: ServiceState | undefined;
    const returned = await service.mutate((draft) => {
      draft.tenants = stateWithNestedValues().tenants;
      retainedDraft = draft;
      return draft.tenants.acme;
    });
    const committed = readState();

    returned.walletTotal = 88;
    returned.workspaces[0].walletCount = 88;
    returned.walletTagRecoveries!['desk-a'].oldTags.push('returned-alias');
    retainedDraft!.tenants.acme.walletTotal = 99;
    retainedDraft!.tenants.acme.workspaces[0].walletCount = 99;
    retainedDraft!.tenants.acme.walletTagRecoveries!['desk-a'].oldTags.push('draft-alias');

    expect(service.tenant('acme')).toEqual(stateWithNestedValues().tenants.acme);
    expect(readState()).toEqual(committed);
  });

  it('rejects unclonable mutation results before persistence and keeps the queue usable', async () => {
    const service = openState();
    const before = readFileSync(paths.stateFile, 'utf8');

    await expect(service.mutate((draft) => {
      draft.tenants = stateWith(1).tenants;
      return () => undefined;
    })).rejects.toThrow();

    expect(readFileSync(paths.stateFile, 'utf8')).toBe(before);
    expect(service.tenant('acme')).toEqual({ walletTotal: 0, workspaces: [] });

    await setTotal(service, 2);
    expect(service.tenant('acme').walletTotal).toBe(2);
  });

  it('serializes queued mutations and retains the previous confirmed snapshot', async () => {
    const service = openState();

    await Promise.all([setTotal(service, 1), setTotal(service, 2)]);

    expect(service.tenant('acme').walletTotal).toBe(2);
    expect(readState().tenants.acme.walletTotal).toBe(2);
    expect(readState(`${paths.stateFile}.bak`).tenants.acme.walletTotal).toBe(1);
  });

  it('recovers a corrupt or missing primary from the last-good backup', async () => {
    const service = openState();
    await setTotal(service, 1);
    await setTotal(service, 2);

    writeFileSync(paths.stateFile, '{truncated', { mode: 0o600 });
    await closeState(service);
    const recoveredCorrupt = openState();
    expect(recoveredCorrupt.tenant('acme').walletTotal).toBe(1);
    expect(readState().tenants.acme.walletTotal).toBe(1);

    await closeState(recoveredCorrupt);
    unlinkSync(paths.stateFile);
    const recoveredMissing = openState();
    expect(recoveredMissing.tenant('acme').walletTotal).toBe(1);
    expect(readState().tenants.acme.walletTotal).toBe(1);
  });

  it('recovers from a regular primary read failure using the valid backup', async () => {
    const service = openState();
    await setTotal(service, 1);
    await setTotal(service, 2);
    let failPrimaryRead = true;
    const fs: ServiceStateFs = {
      ...NODE_SERVICE_STATE_FS,
      read(path) {
        if (failPrimaryRead && path === paths.stateFile) {
          failPrimaryRead = false;
          throw Object.assign(new Error('injected primary read failure'), { code: 'EIO' });
        }
        return NODE_SERVICE_STATE_FS.read(path);
      },
    };

    await closeState(service);
    const recovered = openState(fs);

    expect(recovered.tenant('acme').walletTotal).toBe(1);
    expect(readState().tenants.acme.walletTotal).toBe(1);
  });

  it('repairs an unreadable backup from the valid authoritative primary', async () => {
    const service = openState();
    await setTotal(service, 1);
    let failBackupRead = true;
    const fs: ServiceStateFs = {
      ...NODE_SERVICE_STATE_FS,
      read(path) {
        if (failBackupRead && path === `${paths.stateFile}.bak`) {
          failBackupRead = false;
          throw Object.assign(new Error('injected backup read failure'), { code: 'EIO' });
        }
        return NODE_SERVICE_STATE_FS.read(path);
      },
    };

    await closeState(service);
    const recovered = openState(fs);

    expect(recovered.tenant('acme').walletTotal).toBe(1);
    expect(readState(`${paths.stateFile}.bak`).tenants.acme.walletTotal).toBe(1);
  });

  it('refuses silent reset after an initialized ledger loses both snapshots', async () => {
    const service = openState();
    await closeState(service);
    unlinkSync(paths.stateFile);
    unlinkSync(`${paths.stateFile}.bak`);

    expect(() => openState()).toThrow(
      'has no valid recoverable snapshot',
    );
  });

  it('removes only owned stale temps and leaves unrelated files untouched', async () => {
    const service = openState();
    await closeState(service);
    const stale = `${paths.stateFile}.tmp-${process.pid}-${randomUUID()}`;
    const staleLink = `${paths.stateFile}.bak.tmp-${process.pid}-${randomUUID()}`;
    const lookalike = `${paths.stateFile}.tmp-123-dead-beef`;
    const unrelated = join(paths.stateDir, 'state.json.tmp-not-owned');
    writeFileSync(stale, 'stale');
    symlinkSync(join(baseDir, 'missing-target'), staleLink);
    writeFileSync(lookalike, 'not-created-by-service');
    writeFileSync(unrelated, 'keep');

    openState();

    expect(existsSync(stale)).toBe(false);
    expect(lstatSync(staleLink, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(lookalike, 'utf8')).toBe('not-created-by-service');
    expect(readFileSync(unrelated, 'utf8')).toBe('keep');
  });

  it.each(['current', 'backup', 'marker'] as const)(
    'rejects a symlinked %s candidate without following it',
    async (kind) => {
      const service = openState();
      await closeState(service);
      const target = join(baseDir, `${kind}-target`);
      writeFileSync(target, kind);
      const candidate = kind === 'current'
        ? paths.stateFile
        : kind === 'backup'
          ? `${paths.stateFile}.bak`
          : `${paths.stateFile}.initialized`;
      unlinkSync(candidate);
      symlinkSync(target, candidate);

      expect(() => openState()).toThrow(/not a regular file/);
      expect(readFileSync(target, 'utf8')).toBe(kind);
    },
  );

  it('keeps the queue usable after a pre-commit write failure', async () => {
    let failNextWrite = false;
    const fs: ServiceStateFs = {
      ...NODE_SERVICE_STATE_FS,
      write(fd, bytes) {
        if (failNextWrite) {
          failNextWrite = false;
          throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
        }
        NODE_SERVICE_STATE_FS.write(fd, bytes);
      },
    };
    const service = openState(fs);
    const before = readFileSync(paths.stateFile, 'utf8');
    failNextWrite = true;

    await expect(setTotal(service, 1)).rejects.toThrow('injected write failure');
    expect(readFileSync(paths.stateFile, 'utf8')).toBe(before);
    expect(service.tenant('acme').walletTotal).toBe(0);
    expect(
      NODE_SERVICE_STATE_FS.readdir(paths.stateDir).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);

    await setTotal(service, 2);
    expect(service.tenant('acme').walletTotal).toBe(2);
  });

  it('keeps the confirmed primary authoritative after a backup rename failure', async () => {
    let failBackupRename = false;
    const fs: ServiceStateFs = {
      ...NODE_SERVICE_STATE_FS,
      rename(from, to) {
        if (failBackupRename && to === `${paths.stateFile}.bak`) {
          failBackupRename = false;
          throw Object.assign(new Error('injected backup rename failure'), { code: 'EIO' });
        }
        NODE_SERVICE_STATE_FS.rename(from, to);
      },
    };
    const service = openState(fs);
    await setTotal(service, 1);
    const confirmed = readFileSync(paths.stateFile, 'utf8');
    failBackupRename = true;

    await expect(setTotal(service, 2)).rejects.toThrow('injected backup rename failure');
    expect(readFileSync(paths.stateFile, 'utf8')).toBe(confirmed);
    expect(service.tenant('acme').walletTotal).toBe(1);

    await setTotal(service, 3);
    expect(service.tenant('acme').walletTotal).toBe(3);
  });

  it('poisons the live instance when the final directory fsync fails', async () => {
    let inject = false;
    let primaryRenamed = false;
    const fs: ServiceStateFs = {
      ...NODE_SERVICE_STATE_FS,
      rename(from, to) {
        NODE_SERVICE_STATE_FS.rename(from, to);
        if (inject && to === paths.stateFile) primaryRenamed = true;
      },
      fsync(fd) {
        if (primaryRenamed) {
          primaryRenamed = false;
          throw Object.assign(new Error('injected final directory fsync failure'), { code: 'EIO' });
        }
        NODE_SERVICE_STATE_FS.fsync(fd);
      },
    };
    const service = openState(fs);
    inject = true;

    await expect(setTotal(service, 1)).rejects.toThrow('outcome is indeterminate');
    expect(() => service.tenant('acme')).toThrow('outcome is indeterminate');
    await expect(setTotal(service, 2)).rejects.toThrow('outcome is indeterminate');

    await closeState(service);
    const restarted = openState();
    expect(restarted.tenant('acme').walletTotal).toBe(1);
  });

  it('poisons when primary rename completes and then reports failure', async () => {
    let inject = false;
    const fs: ServiceStateFs = {
      ...NODE_SERVICE_STATE_FS,
      rename(from, to) {
        NODE_SERVICE_STATE_FS.rename(from, to);
        if (inject && to === paths.stateFile) {
          throw Object.assign(new Error('reported after rename'), { code: 'EIO' });
        }
      },
    };
    const service = openState(fs);
    inject = true;

    await expect(setTotal(service, 1)).rejects.toThrow('outcome is indeterminate');
    expect(() => service.tenant('acme')).toThrow('outcome is indeterminate');
    await expect(setTotal(service, 2)).rejects.toThrow('outcome is indeterminate');
    expect(readState().tenants.acme.walletTotal).toBe(1);

    await closeState(service);
    const restarted = openState();
    expect(restarted.tenant('acme').walletTotal).toBe(1);
  });

  it('rejects promise-returning mutation callbacks without persisting them', async () => {
    const service = openState();
    const before = readFileSync(paths.stateFile, 'utf8');

    await expect(
      service.mutate(async (draft) => {
        draft.tenants = stateWith(1).tenants;
      }),
    ).rejects.toThrow('must be synchronous');

    expect(readFileSync(paths.stateFile, 'utf8')).toBe(before);
    expect(service.tenant('acme').walletTotal).toBe(0);
  });

  it('fails closed when backup recovery cannot be durably renamed, then retries cleanly', async () => {
    const service = openState();
    await setTotal(service, 1);
    await setTotal(service, 2);
    writeFileSync(paths.stateFile, '{truncated', { mode: 0o600 });
    const backupBefore = readFileSync(`${paths.stateFile}.bak`, 'utf8');
    let failRecoveryRename = true;
    const fs: ServiceStateFs = {
      ...NODE_SERVICE_STATE_FS,
      rename(from, to) {
        if (failRecoveryRename && to === paths.stateFile) {
          failRecoveryRename = false;
          throw Object.assign(new Error('injected recovery rename failure'), { code: 'EIO' });
        }
        NODE_SERVICE_STATE_FS.rename(from, to);
      },
    };

    await closeState(service);
    expect(() => openState(fs)).toThrow(
      'injected recovery rename failure',
    );
    expect(readFileSync(`${paths.stateFile}.bak`, 'utf8')).toBe(backupBefore);
    expect(readFileSync(paths.stateFile, 'utf8')).toBe('{truncated');

    const recovered = openState();
    expect(recovered.tenant('acme').walletTotal).toBe(1);
    expect(readState().tenants.acme.walletTotal).toBe(1);
  });

  it('refuses boot when neither primary nor backup validates', async () => {
    const service = openState();
    await closeState(service);
    writeFileSync(paths.stateFile, '{bad-primary', { mode: 0o600 });
    writeFileSync(`${paths.stateFile}.bak`, '{bad-backup', { mode: 0o600 });

    expect(() => openState()).toThrow(
      'has no valid recoverable snapshot',
    );
  });

  it('tightens permissive legacy file modes during boot migration', async () => {
    const service = openState();
    await closeState(service);
    chmodSync(paths.stateDir, 0o755);
    chmodSync(paths.stateFile, 0o644);
    chmodSync(`${paths.stateFile}.bak`, 0o644);

    openState();

    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.stateFile).mode & 0o777).toBe(0o600);
    expect(statSync(`${paths.stateFile}.bak`).mode & 0o777).toBe(0o600);
  });

  describe('single-process lifetime lock', () => {
    const validStaleLock = () => `${JSON.stringify({
      version: 1,
      ownerId: randomUUID(),
      pid: 999_999,
      hostname: 'stale-host',
      acquiredAt: '2026-08-12T00:00:00.000Z',
    })}\n`;

    it('rejects a second owner before any state cleanup or snapshot read', () => {
      const first = openState();
      let stateReads = 0;
      let directoryReads = 0;
      const fs: ServiceStateFs = {
        ...NODE_SERVICE_STATE_FS,
        read(path) {
          if (path !== `${paths.stateFile}.lock`) stateReads += 1;
          return NODE_SERVICE_STATE_FS.read(path);
        },
        readdir(path) {
          directoryReads += 1;
          return NODE_SERVICE_STATE_FS.readdir(path);
        },
      };

      expect(() => openState(fs)).toThrow('already locked');
      expect(stateReads).toBe(0);
      expect(directoryReads).toBe(0);
      expect(first.tenant('acme')).toEqual({ walletTotal: 0, workspaces: [] });
    });

    it('permits a new owner only after graceful release and sees durable state', async () => {
      const first = openState();
      await setTotal(first, 3);
      expect(existsSync(`${paths.stateFile}.lock`)).toBe(true);

      await closeState(first);
      expect(existsSync(`${paths.stateFile}.lock`)).toBe(false);
      const second = openState();
      expect(second.tenant('acme').walletTotal).toBe(3);
    });

    it('excludes a real second process and permits it after clean child shutdown', async () => {
      const child = fork(
        join(__dirname, 'fixtures', 'service-state-lock-child.cjs'),
        [JSON.stringify(paths)],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      const childExit = new Promise<void>((resolve, reject) => {
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
        child.once('error', reject);
      });
      const message = (expected: string): Promise<void> => new Promise((resolve, reject) => {
        const onMessage = (value: unknown): void => {
          const result = value as { status?: string; message?: string };
          if (result.status === 'error') reject(new Error(result.message));
          else if (result.status === expected) resolve();
          else child.once('message', onMessage);
        };
        child.once('message', onMessage);
        child.once('error', reject);
      });

      await message('locked');
      expect(() => openState()).toThrow('already locked');
      child.send('close');
      await message('closed');
      await childExit;

      expect(() => openState()).not.toThrow();
    });

    it('never auto-breaks a valid stale lock based on pid or age', () => {
      mkdirSync(paths.stateDir, { recursive: true });
      const metadata = validStaleLock();
      writeFileSync(`${paths.stateFile}.lock`, metadata, { mode: 0o600 });

      expect(() => openState()).toThrow('never reclaims a lock automatically');
      expect(readFileSync(`${paths.stateFile}.lock`, 'utf8')).toBe(metadata);
      expect(existsSync(paths.stateFile)).toBe(false);
    });

    it.each(['symlink', 'directory', 'fifo', 'hardlink', 'wrong-mode', 'malformed'] as const)(
      'rejects an existing %s lock without replacing it',
      (kind) => {
        mkdirSync(paths.stateDir, { recursive: true });
        const lock = `${paths.stateFile}.lock`;
        const target = join(baseDir, `lock-${kind}-target`);
        if (kind === 'symlink') {
          writeFileSync(target, 'keep');
          symlinkSync(target, lock);
        } else if (kind === 'directory') {
          mkdirSync(lock);
        } else if (kind === 'fifo') {
          execFileSync('mkfifo', [lock]);
        } else if (kind === 'hardlink') {
          writeFileSync(target, validStaleLock(), { mode: 0o600 });
          linkSync(target, lock);
        } else if (kind === 'wrong-mode') {
          writeFileSync(lock, validStaleLock(), { mode: 0o644 });
        } else {
          writeFileSync(lock, '{malformed', { mode: 0o600 });
        }

        expect(() => openState()).toThrow();
        expect(existsSync(lock)).toBe(true);
        if (kind === 'symlink') expect(readFileSync(target, 'utf8')).toBe('keep');
        if (kind === 'hardlink') expect(statSync(target).nlink).toBe(2);
      },
    );

    it('retains a crash-stale child lock until explicit operator removal', async () => {
      const child = fork(
        join(__dirname, 'fixtures', 'service-state-lock-child.cjs'),
        [JSON.stringify(paths)],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('message', (value) => {
          const result = value as { status?: string; message?: string };
          result.status === 'locked' ? resolve() : reject(new Error(result.message));
        });
        child.once('error', reject);
      });
      const childExit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await childExit;

      expect(() => openState()).toThrow('never reclaims a lock automatically');
      expect(existsSync(`${paths.stateFile}.lock`)).toBe(true);

      unlinkSync(`${paths.stateFile}.lock`);
      expect(() => openState()).not.toThrow();
    });

    it('does not sweep stale temps while an existing lock blocks boot', () => {
      mkdirSync(paths.stateDir, { recursive: true });
      const stale = `${paths.stateFile}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(stale, 'stale');
      writeFileSync(`${paths.stateFile}.lock`, validStaleLock(), { mode: 0o600 });

      expect(() => openState()).toThrow('already locked');
      expect(readFileSync(stale, 'utf8')).toBe('stale');
    });

    it('identity-checks release and never unlinks a replacement lock', async () => {
      const service = openState();
      const lock = `${paths.stateFile}.lock`;
      unlinkSync(lock);
      const replacement = validStaleLock();
      writeFileSync(lock, replacement, { mode: 0o600 });

      await expect(service.close()).rejects.toThrow('lock retained');
      expect(readFileSync(lock, 'utf8')).toBe(replacement);
    });

    it.each(['directory-fsync', 'descriptor-close', 'unlink'] as const)(
      'retains exclusion when release fails at %s',
      async (fault) => {
        let releasing = false;
        let failed = false;
        const fs: ServiceStateFs = {
          ...NODE_SERVICE_STATE_FS,
          fsync(fd) {
            if (releasing && fault === 'directory-fsync' && !failed) {
              failed = true;
              throw Object.assign(new Error('release directory fsync probe'), { code: 'EIO' });
            }
            NODE_SERVICE_STATE_FS.fsync(fd);
          },
          close(fd) {
            if (releasing && fault === 'descriptor-close' && !failed) {
              failed = true;
              throw Object.assign(new Error('release descriptor close probe'), { code: 'EIO' });
            }
            NODE_SERVICE_STATE_FS.close(fd);
          },
          unlink(path) {
            if (releasing && fault === 'unlink' && path === `${paths.stateFile}.lock` && !failed) {
              failed = true;
              throw Object.assign(new Error('release unlink probe'), { code: 'EIO' });
            }
            NODE_SERVICE_STATE_FS.unlink(path);
          },
        };
        const service = openState(fs);
        releasing = true;

        await expect(service.close()).rejects.toThrow('release');

        expect(existsSync(`${paths.stateFile}.lock`)).toBe(true);
        expect(() => ServiceStateService.fromFile(paths)).toThrow('already locked');
      },
    );

    it('drains accepted queued mutation work and rejects new work after close begins', async () => {
      const service = openState();
      const mutation = setTotal(service, 4);
      const closing = service.close();

      await expect(mutation).resolves.toBeUndefined();
      await expect(closing).resolves.toBeUndefined();
      expect(readState().tenants.acme.walletTotal).toBe(4);
      expect(() => service.tenant('acme')).toThrow('closing');
      await expect(setTotal(service, 5)).rejects.toThrow('closing');
      expect(existsSync(`${paths.stateFile}.lock`)).toBe(false);
    });

    it('cleans up only its own partial lock after an acquisition fsync failure', () => {
      let failLockFsync = true;
      const fs: ServiceStateFs = {
        ...NODE_SERVICE_STATE_FS,
        fsync(fd) {
          if (failLockFsync) {
            failLockFsync = false;
            throw Object.assign(new Error('injected lock fsync failure'), { code: 'EIO' });
          }
          NODE_SERVICE_STATE_FS.fsync(fd);
        },
      };

      expect(() => openState(fs)).toThrow('injected lock fsync failure');
      expect(existsSync(`${paths.stateFile}.lock`)).toBe(false);
      expect(existsSync(paths.stateFile)).toBe(false);
      expect(() => openState()).not.toThrow();
    });

    it('owns cleanup when the first post-create descriptor stat fails', () => {
      let failFirstFstat = true;
      const fs: ServiceStateFs = {
        ...NODE_SERVICE_STATE_FS,
        fstat(fd) {
          if (failFirstFstat) {
            failFirstFstat = false;
            throw Object.assign(new Error('injected lock fstat failure'), { code: 'EIO' });
          }
          return NODE_SERVICE_STATE_FS.fstat(fd);
        },
      };

      expect(() => openState(fs)).toThrow('injected lock fstat failure');
      expect(existsSync(`${paths.stateFile}.lock`)).toBe(false);
      expect(existsSync(paths.stateFile)).toBe(false);
      expect(() => openState()).not.toThrow();
    });

    it('fails closed if the lock pathname is replaced during acquisition', () => {
      let lockFileSynced = false;
      const replacement = validStaleLock();
      const fs: ServiceStateFs = {
        ...NODE_SERVICE_STATE_FS,
        fsync(fd) {
          NODE_SERVICE_STATE_FS.fsync(fd);
          if (!lockFileSynced) {
            lockFileSynced = true;
            unlinkSync(`${paths.stateFile}.lock`);
            writeFileSync(`${paths.stateFile}.lock`, replacement, { mode: 0o600 });
          }
        },
      };

      expect(() => openState(fs)).toThrow('partial lock cleanup failed');
      expect(readFileSync(`${paths.stateFile}.lock`, 'utf8')).toBe(replacement);
      expect(existsSync(paths.stateFile)).toBe(false);
    });

    it('releases its lock after a later boot recovery failure', () => {
      mkdirSync(paths.stateDir, { recursive: true });
      writeFileSync(paths.stateFile, '{bad-primary', { mode: 0o600 });
      writeFileSync(`${paths.stateFile}.bak`, '{bad-backup', { mode: 0o600 });

      expect(() => openState()).toThrow('no valid recoverable snapshot');
      expect(existsSync(`${paths.stateFile}.lock`)).toBe(false);
    });
  });
});
