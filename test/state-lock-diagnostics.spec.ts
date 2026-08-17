import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceStateService } from '../src/config/service-state.service';
import type { Paths } from '../src/config/paths';

/**
 * A crash-stale lock is only ever removed by a human, so the refusal has to
 * tell them which file and why. See AUDIT-FINDINGS R-05.
 */
describe('state lock refusal is actionable (R-05)', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function withLock(contents: string | null, mode = 0o600): { paths: Paths; lock: string } {
    const base = mkdtempSync(join(tmpdir(), 'tee-lock-diag-'));
    dirs.push(base);
    const stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    const lock = join(stateDir, 'state.json.lock');
    writeFileSync(lock, contents ?? '');
    chmodSync(lock, mode);
    const configDir = join(base, 'config');
    return {
      paths: {
        configDir,
        stateDir,
        dataRoot: join(base, 'data'),
        tenantsFile: join(configDir, 'tenants.json'),
        errorsFile: join(configDir, 'errors.json'),
        stateFile: join(stateDir, 'state.json'),
      } satisfies Paths,
      lock,
    };
  }

  const valid = JSON.stringify({
    version: 1,
    ownerId: '00000000-0000-4000-8000-000000000000',
    pid: 424242,
    hostname: 'probe-host-name',
    acquiredAt: '2026-08-17T00:00:00.000Z',
  });

  it.each([
    ['a well-formed stale lock', valid, 0o600],
    ['a zero-byte lock', '', 0o600],
    ['a truncated lock', '{"version":1,"ownerId":', 0o600],
    ['a world-readable lock', valid, 0o644],
  ])('names the file and the remedy for %s', (_name, contents, mode) => {
    const { paths, lock } = withLock(contents, mode);
    let message = '';
    try {
      ServiceStateService.fromFile(paths);
      throw new Error('expected a refusal');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(lock);
    expect(message).toContain('never reclaims a lock automatically');
    expect(message).toContain('docs/OPERATIONS.md');
  });

  it('never reports the recorded pid, hostname or timestamp', () => {
    // The standing guard against a future pid-liveness "improvement": those
    // values are the only data in the file and all three are misleading, so
    // showing them invites the operator to infer liveness by hand.
    const { paths } = withLock(valid);
    let message = '';
    try {
      ServiceStateService.fromFile(paths);
      throw new Error('expected a refusal');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('424242');
    expect(message).not.toContain('probe-host-name');
    expect(message).not.toContain('2026-08-17T00:00:00.000Z');
  });

  it('refuses rather than reclaiming, whatever the recorded pid', () => {
    for (const pid of [1, 424242, process.pid]) {
      const { paths } = withLock(JSON.stringify({
        version: 1,
        ownerId: '00000000-0000-4000-8000-000000000000',
        pid,
        hostname: 'probe-host-name',
        acquiredAt: '2026-08-17T00:00:00.000Z',
      }));
      expect(() => ServiceStateService.fromFile(paths)).toThrow('already locked');
    }
  });
});
