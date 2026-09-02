import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read/modify/write access to the hand-edited operator config.
 *
 * Everything here works on the RAW `JSON.parse` result, never on a schema-
 * parsed one. Neither TenantSchema nor TenantsConfigSchema is `.strict()`, so
 * zod silently STRIPS the keys an operator relies on — the `_comment` block and
 * the `_exportPublicKey` / `_rpc` / `_origins` markers whose whole purpose is
 * staying inert until they are renamed. Round-tripping through the schema would
 * erase all of it on the first admin call. The schema is a validation gate on a
 * throwaway copy; the bytes written come from the raw graph.
 */

export interface RawTenantsFile {
  /** The untouched parse. Mutate in place, then hand it back to `write`. */
  readonly raw: Record<string, unknown>;
  readonly tenants: Record<string, unknown>[];
}

export function readTenantsFile(path: string): RawTenantsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`cannot read operator config at ${path}`, { cause });
  }

  if (!isRecord(parsed)) throw new Error(`operator config at ${path} is not an object`);
  const tenants = parsed.tenants;
  if (!Array.isArray(tenants) || !tenants.every(isRecord)) {
    throw new Error(`operator config at ${path} has no tenants array`);
  }
  return { raw: parsed, tenants: tenants as Record<string, unknown>[] };
}

/** The raw entry for one tenant id, or null when the file no longer lists it. */
export function findRawTenant(
  file: RawTenantsFile,
  tenantId: string,
): Record<string, unknown> | null {
  return file.tenants.find((entry) => entry.id === tenantId) ?? null;
}

/**
 * Replace the file atomically: temp -> fsync -> rename -> directory fsync.
 *
 * This file holds every tenant's API key and secret hash. A torn write during a
 * crash would leave the service unable to authenticate anyone, so the same
 * durability barriers the state ledger uses apply here. The temp file is
 * created O_EXCL|O_NOFOLLOW at the target's own mode, so a lift never widens
 * the permissions an operator set.
 */
export function writeTenantsFile(path: string, raw: Record<string, unknown>): void {
  const mode = lstatSync(path).mode & 0o777;
  const dir = dirname(path);
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;

  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(fd, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the first failure */ }
    }
    cleanup(temp);
    throw error;
  }

  try {
    renameSync(temp, path);
    syncDirectory(dir);
  } catch (error) {
    cleanup(temp);
    throw error;
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function cleanup(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Cleanup must not replace the durability failure that caused it.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
