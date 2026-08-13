import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OperatorConfigService } from '../src/config/operator-config.service';
import { parseRecipient, seal, validateRecipient } from '../src/export/seal';
import type { Paths } from '../src/config/paths';
import { DEFAULT_TENANT } from './harness/boot';
import { newRecipient, unseal } from './harness/unseal';

function paths(tenantsFile: string): Paths {
  const base = resolve(tenantsFile, '..');
  return {
    configDir: base,
    stateDir: join(base, 'state'),
    dataRoot: join(base, 'data'),
    tenantsFile,
    errorsFile: join(base, 'errors.json'),
    stateFile: join(base, 'state', 'state.json'),
  };
}

function load(exportPublicKey?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tee-recipient-'));
  const file = join(dir, 'tenants.json');
  const tenant = exportPublicKey === undefined
    ? DEFAULT_TENANT
    : { ...DEFAULT_TENANT, exportPublicKey };
  writeFileSync(file, JSON.stringify({ tenants: [tenant] }));
  try {
    return OperatorConfigService.fromFile(paths(file)).byId(DEFAULT_TENANT.id)!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('operator export recipient validation', () => {
  it('treats absence as the sole disabled state', () => {
    expect(load()).toMatchObject({ exportEnabled: false, exportPublicKey: undefined });
  });

  it('boots with a generated recipient and produces a decryptable seal', () => {
    const recipient = newRecipient();
    expect(load(recipient.configured)).toMatchObject({
      exportEnabled: true,
      exportPublicKey: recipient.configured,
    });
    expect(unseal(seal('recovery secret', recipient.configured), recipient.privateKey))
      .toBe('recovery secret');
  });

  it.each([
    ['wrong scheme', 'X25519:' + Buffer.alloc(32, 9).toString('base64')],
    ['extra colon', 'x25519:' + Buffer.alloc(32, 9).toString('base64') + ':tail'],
    ['31 bytes', 'x25519:' + Buffer.alloc(31, 9).toString('base64')],
    ['33 bytes', 'x25519:' + Buffer.alloc(33, 9).toString('base64')],
    ['missing padding', 'x25519:' + Buffer.alloc(32, 9).toString('base64').slice(0, -1)],
    ['URL alphabet', 'x25519:' + Buffer.alloc(32, 255).toString('base64url')],
    ['all zero low order', 'x25519:' + Buffer.alloc(32).toString('base64')],
    ['u=1 low order', 'x25519:' + Buffer.from([1, ...Array(31).fill(0)]).toString('base64')],
  ])('refuses %s at config load', (_name, configured) => {
    expect(() => load(configured)).toThrow();
  });

  it('rejects noncanonical base64 pad bits even when bytes decode identically', () => {
    const recipient = newRecipient().configured;
    const encoded = recipient.slice('x25519:'.length);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const index = alphabet.indexOf(encoded.at(-2)!);
    const alias = `${encoded.slice(0, -2)}${alphabet[(index ^ 1) % 64]}=`;
    expect(Buffer.from(alias, 'base64')).toEqual(Buffer.from(encoded, 'base64'));
    expect(() => parseRecipient(`x25519:${alias}`)).toThrow();
  });

  it('returns a fixed boot error that never contains key material or crypto details', () => {
    const configured = `x25519:${Buffer.alloc(32).toString('base64')}`;
    let caught: unknown;
    try {
      validateRecipient(configured);
    } catch (error) {
      caught = error;
    }
    const rendered = String(caught);
    expect(rendered).toBe('Error: exportPublicKey is not a usable X25519 recipient');
    expect(rendered).not.toContain(configured);
    expect(rendered).not.toContain('OpenSSL');
  });

  it('ships an unmistakable replacement marker, never a plausible low-order key', () => {
    const example = JSON.parse(readFileSync(
      resolve(__dirname, '../config/tenants.example.json'),
      'utf8',
    )) as { tenants: Array<{ exportPublicKey?: string }> };
    expect(example.tenants[0]?.exportPublicKey).toBe('REPLACE_ME_WITH_X25519_BASE64_PUBLIC_KEY');
    expect(() => validateRecipient(example.tenants[0]!.exportPublicKey!)).toThrow();
  });

  it('accepts ordinary generated Node X25519 keys', () => {
    const { publicKey } = generateKeyPairSync('x25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    expect(() => validateRecipient(`x25519:${raw.toString('base64')}`)).not.toThrow();
  });
});
