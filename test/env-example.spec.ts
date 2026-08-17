import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hashApiSecret } from '../src/auth/secret';

const ROOT = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('.env.example completeness (L-08)', () => {
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const documented = new Set(
    example
      .split('\n')
      .map((line) => /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line.trim())?.[1])
      .filter((name): name is string => Boolean(name)),
  );

  it('documents every environment variable the service reads', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) used.add(match[1]!);
      for (const match of source.matchAll(/env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) used.add(match[1]!);
    }
    // NODE_ENV is set by the runtime, not by operator config.
    used.delete('NODE_ENV');

    const missing = [...used].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
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
