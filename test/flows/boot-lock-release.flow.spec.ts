import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');

/**
 * A failed boot must not leave the ledger lock behind.
 *
 * The lock is taken by ConfigModule's factory DURING NestFactory.create, so a
 * failure inside create leaves no INestApplication to close. Nothing exercised
 * src/main.ts before this, which is how a fix contradicting its own commit
 * message shipped green. See AUDIT-FINDINGS R-05.
 */
describe('failed boot releases the state lock (R-05)', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function bootWith(env: Record<string, string>): { code: number; stateDir: string } {
    const base = mkdtempSync(join(tmpdir(), 'tee-boot-lock-'));
    dirs.push(base);
    const stateDir = join(base, 'state');
    const configDir = join(base, 'config');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'tenants.json'),
      JSON.stringify({
        tenants: [{
          id: 'acme',
          apiKey: 'ak_test_0123456789abcdef',
          secretHash: '0'.repeat(64),
          limits: { maxWorkspaces: 2, maxWallets: 10 },
        }],
      }),
    );
    writeFileSync(join(configDir, 'errors.json'), JSON.stringify(
      JSON.parse(execFileSync('cat', [join(ROOT, 'config/errors.json')], { encoding: 'utf8' })),
    ));

    let code = 0;
    try {
      execFileSync('node', [join(ROOT, 'dist/main.js')], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: '0',
          TEE_STATE_DIR: stateDir,
          TEE_CONFIG_DIR: configDir,
          WATIVE_DATA_ROOT: join(base, 'data'),
          TEE_SECRET_HMAC_KEY: 'a1'.repeat(16),
          ...env,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch (err) {
      code = (err as { status?: number }).status ?? 1;
    }
    return { code, stateDir };
  }

  it.each([
    ['a short HMAC key', { TEE_SECRET_HMAC_KEY: 'ab' }],
    ['a removed setting', { TEE_SKIP_KDF_CHECK: '1' }],
    ['an invalid mint limit', { TEE_MINT_RATE_LIMIT: '0' }],
    ['an unreadable operator config', { TEE_CONFIG_DIR: '/nonexistent-config-dir' }],
  ])('does not strand the lock after %s', (_name, env) => {
    const { code, stateDir } = bootWith(env);
    expect(code).not.toBe(0);
    // The whole point: a config typo must not block the next start.
    expect(existsSync(join(stateDir, 'state.json.lock'))).toBe(false);
  });
});
