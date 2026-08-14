import type { Transaction } from 'wative-core';
import { TeeError } from '../common/tee-error';

const MAX_PROJECTED_BYTES = 100 * 1024;
const MAX_TEXT = 128;
const MAX_DATA = 100 * 1024;
const MAX_LIST = 256;
const MAX_INSTRUCTION_DATA = 1_232;
const UINT256_RE = /^(0|[1-9]\d{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58].map((character, index) => [character, index]));

export async function projectBuiltTransaction(tx: Transaction): Promise<unknown> {
  const raw = await rawTransaction(tx);
  let projected: Record<string, unknown>;
  if (tx.vm === 'evm') projected = projectEvm(raw);
  else if (tx.vm === 'svm') projected = projectSvm(raw);
  else throw invalidRaw();
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MAX_PROJECTED_BYTES) {
    throw invalidRaw();
  }
  return projected;
}

async function rawTransaction(tx: Transaction): Promise<unknown> {
  const fn = (tx as unknown as { toRawTx?: () => unknown }).toRawTx;
  if (typeof fn !== 'function') {
    throw new TeeError('TEE_UNSUPPORTED_FOR_KIND', 'this transaction cannot be rendered as raw');
  }
  return await fn.call(tx);
}

function projectEvm(value: unknown): Record<string, unknown> {
  const raw = object(value);
  const projected: Record<string, unknown> = {
    from: text(own(raw, 'from'), MAX_TEXT),
    to: text(own(raw, 'to'), MAX_TEXT),
    value: uint(own(raw, 'value')),
    data: text(own(raw, 'data'), MAX_DATA),
    type: oneOf(own(raw, 'type'), [0, 1, 2]),
    chainId: safeUint(own(raw, 'chainId')),
  };
  optional(raw, projected, 'nonce', safeUint);
  optional(raw, projected, 'gasPrice', uint);
  optional(raw, projected, 'maxFeePerGas', uint);
  optional(raw, projected, 'maxPriorityFeePerGas', uint);
  optional(raw, projected, 'gasLimit', uint);
  const accessList = ownOptional(raw, 'accessList');
  if (accessList !== undefined) {
    projected.accessList = mapList(accessList, MAX_LIST, (entry) => {
      const item = object(entry);
      return {
        address: text(own(item, 'address'), MAX_TEXT),
        storageKeys: mapList(own(item, 'storageKeys'), MAX_LIST, (key) => text(key, MAX_TEXT)),
      };
    });
  }
  return projected;
}

function projectSvm(value: unknown): Record<string, unknown> {
  const raw = object(value);
  const feePayer = nullablePublicKey(ownOptional(raw, 'feePayer'));
  const recentBlockhash = nullableText(ownOptional(raw, 'recentBlockhash'), 64);
  const instructions = mapList(own(raw, 'instructions'), MAX_LIST, (entry) => {
    const instruction = object(entry);
    const data = bytes(own(instruction, 'data'));
    return {
      keys: mapList(own(instruction, 'keys'), MAX_LIST, (entryKey) => {
        const key = object(entryKey);
        return {
          pubkey: publicKey(own(key, 'pubkey')),
          isSigner: bool(own(key, 'isSigner')),
          isWritable: bool(own(key, 'isWritable')),
        };
      }),
      programId: publicKey(own(instruction, 'programId')),
      data,
    };
  });
  const signers = mapList(own(raw, 'signatures'), MAX_LIST, (entry) =>
    publicKey(own(object(entry), 'publicKey')),
  );

  const nonceInfo = ownOptional(raw, 'nonceInfo');
  if (nonceInfo !== undefined && nonceInfo !== null) throw invalidRaw();
  return { recentBlockhash, feePayer, nonceInfo: null, instructions, signers };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidRaw();
  return value as Record<string, unknown>;
}

function own(source: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor || !('value' in descriptor)) throw invalidRaw();
  return descriptor.value;
}

function ownOptional(source: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw invalidRaw();
  return descriptor.value;
}

function mapList<T>(value: unknown, max: number, project: (value: unknown) => T): T[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).some((key) =>
      key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)),
    ) ||
    value.length > max
  ) {
    throw invalidRaw();
  }
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw invalidRaw();
    result.push(project(descriptor.value));
  }
  return result;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw invalidRaw();
  return value;
}

function nullableText(value: unknown, max: number): string | null {
  return value === null || value === undefined ? null : text(value, max);
}

function safeUint(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidRaw();
  return value as number;
}

function oneOf<T>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw invalidRaw();
  return value as T;
}

function uint(value: unknown): string {
  let rendered: string;
  if (typeof value === 'bigint') rendered = value.toString();
  else if (typeof value === 'string') rendered = value;
  else if (Number.isSafeInteger(value) && (value as number) >= 0) rendered = String(value);
  else throw invalidRaw();
  if (!UINT256_RE.test(rendered) || BigInt(rendered) > UINT256_MAX) throw invalidRaw();
  return rendered;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidRaw();
  return value;
}

function publicKey(value: unknown): string {
  if (typeof value === 'string') {
    const decoded = decodeBase58(text(value, 64));
    if (decoded.length !== 32 || encodeBase58(decoded) !== value) throw invalidRaw();
    return value;
  }
  if (value === null || typeof value !== 'object') throw invalidRaw();
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (!prototype) throw invalidRaw();
  const toBytes = Object.getOwnPropertyDescriptor(prototype, 'toBytes')?.value as unknown;
  if (typeof toBytes !== 'function') throw invalidRaw();
  const rawBytes = Reflect.apply(toBytes, value, []) as unknown;
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length !== 32) throw invalidRaw();
  return encodeBase58(rawBytes);
}

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  return '1'.repeat(zeroes) + encoded;
}

function decodeBase58(value: string): Uint8Array {
  if (!value) throw invalidRaw();
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) throw invalidRaw();
    decoded = decoded * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (decoded > 0n) {
    body.push(Number(decoded & 0xffn));
    decoded >>= 8n;
  }
  body.reverse();
  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === '1') zeroes += 1;
  return Uint8Array.from([...Array.from({ length: zeroes }, () => 0), ...body]);
}

function nullablePublicKey(value: unknown): string | null {
  return value === null || value === undefined ? null : publicKey(value);
}

function bytes(value: unknown): number[] {
  if (!(value instanceof Uint8Array) && (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)) {
    throw invalidRaw();
  }
  if (value.length > MAX_INSTRUCTION_DATA) throw invalidRaw();
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const byte = value instanceof Uint8Array
      ? value[index]
      : own(value as unknown as Record<string, unknown>, String(index));
    if (!Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255) throw invalidRaw();
    result.push(byte as number);
  }
  return result;
}

function optional(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  projector: (value: unknown) => unknown,
): void {
  const value = ownOptional(source, key);
  if (value !== undefined) target[key] = projector(value);
}

function invalidRaw(): TeeError {
  return new TeeError('TEE_UNSUPPORTED_FOR_KIND', 'transaction raw shape is not supported');
}
