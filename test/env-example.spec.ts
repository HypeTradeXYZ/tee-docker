import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hashApiSecret } from '../src/auth/secret';

const ROOT = join(__dirname, '..');
// TEE_-prefixed error codes share the namespace but are not settings.
const ERROR_CODES = new Set<string>(
  (readFileSync(join(ROOT, 'src/common/tee-error.ts'), 'utf8').match(/'(TEE_[A-Z0-9_]+)'/g) ?? [])
    .map((quoted) => quoted.slice(1, -1)),
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('.env.example completeness (L-08)', () => {
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  // A definition line, or a commented-out one — NOT a name mentioned inside an
  // indented usage example, which would otherwise count as "documented".
  const definitions = example
    .split('\n')
    .map((line) => /^#? ?([A-Z][A-Z0-9_]+)=/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
  const documented = new Set(definitions);

  it('documents every environment variable the service reads', () => {
    // Matching `env.NAME` only was blind to six live settings, because the
    // codebase's own idiom passes the name to a helper: parse(env, 'NAME', ...).
    // Any TEE_/WATIVE_ string literal in src/ or scripts/ counts as a read.
    const used = new Set<string>();
    const roots = [join(ROOT, 'src'), join(ROOT, 'scripts')];
    for (const file of roots.flatMap((dir) => sourceFiles(dir))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) used.add(match[1]!);
      for (const match of source.matchAll(/env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) used.add(match[1]!);
      // Any TEE_/WATIVE_ literal that is not an error code. Both helper idioms
      // in this codebase pass the name as a string — parse(env, 'NAME') and
      // parse('NAME', fallback) reading process.env[name] — so matching a call
      // shape misses one of them, and the manually-maintained list below is
      // exactly what this test exists to remove.
      for (const match of source.matchAll(/['"`]((?:TEE|WATIVE)_[A-Z0-9_]+)['"`]/g)) {
        if (!ERROR_CODES.has(match[1]!)) used.add(match[1]!);
      }
    }
    // NODE_ENV is set by the runtime, not by operator config.
    used.delete('NODE_ENV');
    // Removed, and documented in .env.example as removed rather than as a knob.
    used.delete('TEE_SKIP_KDF_CHECK');

    const missing = [...used].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('catches a setting that is read through a helper, not as env.NAME', () => {
    // Kept as an explicit expectation, but the check above no longer depends
    // on this list: it scans literals, so a new setting added the way these
    // were added is caught without editing the test.
    const viaHelper = [
      'TEE_MAX_UNLOCKED_WORKSPACES',
      'TEE_MAX_TOKEN_LEASES_PER_WORKSPACE',
      'TEE_RPC_DEADLINE_MS',
      'TEE_MAX_RPC_OPERATIONS_PER_TENANT',
      'TEE_WORKSPACE_CREATE_RATE_LIMIT',
      'TEE_WORKSPACE_RECREATE_COOLDOWN_SEC',
    ];
    for (const name of viaHelper) expect(documented.has(name)).toBe(true);
  });

  it('never documents a variable whose presence breaks boot', () => {
    // TEE_SKIP_KDF_CHECK throws by design; an operator uncommenting a line
    // this file offered them is the exact failure L-08 exists to prevent.
    const active = example
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(active).not.toContain('TEE_SKIP_KDF_CHECK');
    const offered = /^#\s*TEE_SKIP_KDF_CHECK=/m.test(example);
    expect(offered).toBe(false);
  });

  it('documents each variable exactly once', () => {
    const duplicated = definitions.filter((name, i) => definitions.indexOf(name) !== i);
    expect([...new Set(duplicated)]).toEqual([]);
  });

  it('names the key whose absence is a hard boot failure', () => {
    // It was absent entirely, so an operator following the file's own
    // instructions produced a container that crash-loops on boot.
    expect(documented.has('TEE_SECRET_HMAC_KEY')).toBe(true);
  });
});

describe('hash-secret helper (L-08)', () => {
  it('produces the hash the service verifies against', () => {
    const key = 'a1'.repeat(16);
    const secret = 'sk_test_super_secret_value_0123456789';
    const out = execFileSync('node', [join(ROOT, 'scripts/hash-secret.mjs'), secret], {
      env: { ...process.env, TEE_SECRET_HMAC_KEY: key },
      encoding: 'utf8',
    }).trim();

    expect(out).toBe(hashApiSecret(secret, Buffer.from(key, 'hex')));
    expect(out).toBe(createHmac('sha256', Buffer.from(key, 'hex')).update(secret, 'utf8').digest('hex'));
  });

  it('refuses to run without a server key, and never echoes the secret', () => {
    const env = { ...process.env };
    delete env.TEE_SECRET_HMAC_KEY;
    let stderr = '';
    try {
      execFileSync('node', [join(ROOT, 'scripts/hash-secret.mjs'), 'sk_never_echo_me'], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('expected a failure');
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(stderr).toContain('TEE_SECRET_HMAC_KEY is not set');
    expect(stderr).not.toContain('sk_never_echo_me');
  });
});
