import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TeeError } from '../common/tee-error';
import { SERVER_KEY } from './server-key';

export interface TokenClaims {
  readonly tid: string;
  readonly ws: string;
  readonly sid: string;
  /** Stable, server-tracked token lease id. */
  readonly jti: string;
  readonly scp: string[];
  readonly exp: number;
  readonly iat: number;
}

const SUPPORTED_SCOPES = new Set(['read', 'write', 'sign', 'export']);
const b64url = (buf: Buffer): string => buf.toString('base64url');

@Injectable()
export class JwtService {
  readonly #key: Buffer;

  constructor(@Inject(SERVER_KEY) serverKey: Buffer) {
    this.#key = Buffer.from(hkdfSync('sha256', serverKey, '', 'tee-docker:jwt:v1', 32));
  }

  sign(claims: Omit<TokenClaims, 'iat' | 'exp'>, exp: number): { token: string; exp: number } {
    const iat = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(exp) || exp <= iat) throw expired('invalid token lifetime');
    const payload: TokenClaims = { ...claims, iat, exp };
    const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    return { token: `${head}.${body}.${this.mac(`${head}.${body}`)}`, exp };
  }

  verify(token: string): TokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw expired('malformed token');
    const [head, body, sig] = parts as [string, string, string];

    const expected = Buffer.from(this.mac(`${head}.${body}`), 'utf8');
    const actual = Buffer.from(sig, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw expired('bad signature');
    }

    const header = parseObject(head, 'unreadable header');
    if (header.alg !== 'HS256' || header.typ !== 'JWT') throw expired('unexpected header');

    const raw = parseObject(body, 'unreadable claims');
    if (
      !isNonemptyString(raw.tid) ||
      !isNonemptyString(raw.ws) ||
      !isNonemptyString(raw.sid) ||
      !isNonemptyString(raw.jti) ||
      !Number.isSafeInteger(raw.iat) ||
      !Number.isSafeInteger(raw.exp) ||
      (raw.exp as number) <= (raw.iat as number) ||
      (raw.iat as number) > Math.floor(Date.now() / 1000) + 30 ||
      !validScopes(raw.scp)
    ) {
      throw expired('invalid claims');
    }
    if (Math.floor(Date.now() / 1000) >= (raw.exp as number)) throw expired('token expired');
    return raw as unknown as TokenClaims;
  }

  private mac(input: string): string {
    return b64url(createHmac('sha256', this.#key).update(input).digest());
  }
}

function parseObject(value: string, reason: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw expired(reason);
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validScopes(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonemptyString)) return false;
  return new Set(value).size === value.length && value.every((scope) => SUPPORTED_SCOPES.has(scope));
}

function expired(reason: string): TeeError {
  return new TeeError('TEE_SESSION_EXPIRED', 'session is not valid', { reason });
}
