import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { BUILTIN_NETWORKS, Network, type Workspace } from 'wative-core';
import { SERVER_KEY } from '../auth/server-key';
import { TeeError } from '../common/tee-error';
import { OperatorConfigService } from '../config/operator-config.service';
import type { RpcSource } from './rpc';

const MAX_TARGET_URL_BYTES = 2_048;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CONCURRENT_REQUESTS = 64;
const MAX_CAPABILITIES_PER_WORKSPACE = 256;
const DNS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CAPABILITY_AAD = Buffer.from('tee-docker:rpc-capability:v1');

interface Capability {
  readonly v: 1;
  readonly tenantId: string;
  readonly workspaceSlug: string;
  readonly target: string;
  readonly source: RpcSource;
}

export interface PublicAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type RpcDnsResolver = (hostname: string) => Promise<readonly PublicAddress[]>;
export const RPC_DNS_RESOLVER = Symbol('tee-docker:rpc-dns-resolver');
export type RpcHttpsRequester = typeof httpsRequest;
export const RPC_HTTPS_REQUESTER = Symbol('tee-docker:rpc-https-requester');

export async function systemRpcDnsResolver(hostname: string): Promise<readonly PublicAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
}

const BUILTIN_URL = new Map<string, string>(
  Object.values(BUILTIN_NETWORKS as Record<string, { slug: string; rpcUrl: string }>).map(
    (network) => [String(network.slug), canonicalUrl(network.rpcUrl)] as const,
  ),
);

/**
 * The only network egress boundary used by wative-core.
 *
 * Core receives an opaque loopback capability instead of the real tenant URL.
 * The capability encrypts and authenticates the target, survives a restart,
 * and cannot be retargeted. Every actual connection is re-resolved, checked,
 * and pinned here before TLS is allowed to leave the process.
 */
@Injectable()
export class RpcBoundaryService implements OnModuleInit, OnApplicationShutdown {
  private readonly key: Buffer;
  private server: Server | null = null;
  private relayOrigin: string | null = null;
  private activeRequests = 0;
  private readonly activeCapabilities = new Map<string, Set<string>>();
  private readonly outboundAborts = new Map<AbortController, string>();
  private readonly workspaceAbortBlocks = new Map<string, number>();
  private readonly workspaceDrainWaiters = new Map<string, Set<() => void>>();
  private shutdownDrain: Promise<void> | null = null;
  private resolveShutdownDrain: (() => void) | null = null;
  private shuttingDown = false;
  private readonly dnsResolver: RpcDnsResolver;
  private readonly requester: RpcHttpsRequester;

  constructor(
    @Inject(SERVER_KEY) serverKey: Buffer,
    private readonly tenants: OperatorConfigService,
    @Optional() @Inject(RPC_DNS_RESOLVER) dnsResolver?: RpcDnsResolver,
    @Optional() @Inject(RPC_HTTPS_REQUESTER) requester?: RpcHttpsRequester,
  ) {
    this.key = createHash('sha256')
      .update('tee-docker:rpc-capability:key\0')
      .update(serverKey)
      .digest();
    this.dnsResolver = dnsResolver ?? systemRpcDnsResolver;
    this.requester = requester ?? httpsRequest;
  }

  async onModuleInit(): Promise<void> {
    this.shuttingDown = false;
    // Operator-supplied endpoints are configuration, not runtime input. Refuse
    // to boot if any one of them is syntactically unsafe or currently resolves
    // outside the public Internet.
    for (const tenant of this.tenants.all) {
      for (const rpcUrl of Object.values(tenant.rpc)) {
        try {
          await this.admit(rpcUrl);
        } catch (cause) {
          throw new Error(`tenant ${tenant.id} has an unsafe RPC endpoint`, { cause });
        }
      }
    }

    const server = createServer((req, res) => void this.serve(req, res));
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = Math.min(REQUEST_TIMEOUT_MS, 10_000);
    server.maxHeadersCount = 32;
    server.on('upgrade', (_req, socket) => {
      // Core has no approved WebSocket operation today. Refusing upgrades at
      // the loopback boundary prevents a future library path from bypassing
      // the pinned HTTPS transport.
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('RPC relay did not acquire a loopback port');
    }
    this.server = server;
    this.relayOrigin = `http://127.0.0.1:${address.port}`;
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    const server = this.server;
    this.server = null;
    this.relayOrigin = null;
    this.activeCapabilities.clear();
    this.workspaceAbortBlocks.clear();
    if (!server) return;
    if (this.activeRequests > 0) {
      this.shutdownDrain = new Promise<void>((resolve) => {
        this.resolveShutdownDrain = resolve;
      });
    }
    for (const controller of this.outboundAborts.keys()) controller.abort();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    });
    await this.shutdownDrain;
    this.workspaceDrainWaiters.clear();
  }

  /** Validate a newly supplied external target before it can be persisted. */
  async admit(raw: string): Promise<string> {
    const target = parseRpcTarget(raw);
    await this.resolvePublic(target.hostname);
    return target.href;
  }

  /**
   * Abort live transport and reject later relay calls from the same operation
   * until its caller confirms that the underlying core promise has settled.
   */
  abortWorkspace(tenantId: string, workspaceSlug: string): () => void {
    const key = capabilityWorkspaceKey(tenantId, workspaceSlug);
    this.workspaceAbortBlocks.set(key, (this.workspaceAbortBlocks.get(key) ?? 0) + 1);
    for (const [controller, workspaceKey] of this.outboundAborts) {
      if (workspaceKey === key) controller.abort();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.workspaceAbortBlocks.get(key) ?? 1) - 1;
      if (remaining <= 0) this.workspaceAbortBlocks.delete(key);
      else this.workspaceAbortBlocks.set(key, remaining);
    };
  }

  /** Wait until every relay request already admitted for this workspace exits. */
  waitForWorkspaceDrain(tenantId: string, workspaceSlug: string): Promise<void> {
    const key = capabilityWorkspaceKey(tenantId, workspaceSlug);
    if (![...this.outboundAborts.values()].includes(key)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.workspaceDrainWaiters.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      this.workspaceDrainWaiters.set(key, waiters);
    });
  }

  /** Create an immutable, tenant/workspace-bound loopback capability. */
  relayUrl(
    raw: string,
    tenantId: string,
    workspaceSlug: string,
    source: RpcSource,
  ): string {
    const target = parseRpcTarget(raw).href;
    const origin = this.relayOrigin;
    if (!origin) throw new Error('RPC boundary is not initialized');
    const encoded = this.seal({ v: 1, tenantId, workspaceSlug, target, source });
    const key = capabilityWorkspaceKey(tenantId, workspaceSlug);
    const active = this.activeCapabilities.get(key) ?? new Set<string>();
    active.add(encoded);
    while (active.size > MAX_CAPABILITIES_PER_WORKSPACE) {
      const oldest = active.values().next().value as string | undefined;
      if (!oldest) break;
      active.delete(oldest);
    }
    this.activeCapabilities.set(key, active);
    return `${origin}/rpc/${encoded}`;
  }

  /** Retire one superseded immutable target without disturbing sibling networks. */
  revokeCapability(url: string): void {
    const encoded = relayToken(url, this.relayOrigin, false);
    if (!encoded) return;
    let capability: Capability;
    try {
      capability = this.open(encoded);
    } catch {
      return;
    }
    const key = capabilityWorkspaceKey(capability.tenantId, capability.workspaceSlug);
    const active = this.activeCapabilities.get(key);
    active?.delete(encoded);
    if (active?.size === 0) this.activeCapabilities.delete(key);
  }

  /** Revoke every relay capability when the owning singleton leaves custody. */
  revokeWorkspace(tenantId: string, workspaceSlug: string): void {
    const key = capabilityWorkspaceKey(tenantId, workspaceSlug);
    this.activeCapabilities.delete(key);
    for (const [controller, workspaceKey] of this.outboundAborts) {
      if (workspaceKey === key) controller.abort();
    }
  }

  /** Decode a relay URL only for the workspace to which it was issued. */
  inspect(url: string, tenantId: string, workspaceSlug: string): Capability {
    const encoded = relayToken(url, this.relayOrigin, true);
    if (!encoded) throw rejectedEndpoint();
    const capability = this.open(encoded);
    if (
      capability.tenantId !== tenantId ||
      capability.workspaceSlug !== workspaceSlug
    ) {
      throw rejectedEndpoint();
    }
    const active = this.activeCapabilities.get(
      capabilityWorkspaceKey(capability.tenantId, capability.workspaceSlug),
    );
    if (!active?.has(encoded)) throw rejectedEndpoint();
    parseRpcTarget(capability.target);
    return capability;
  }

  /**
   * Replace every external URL in an unlocked core Network with a capability.
   * Existing capabilities are decrypted and reissued for this process's
   * ephemeral loopback port; their immutable target and source are preserved.
   */
  async hardenWorkspace(
    handle: Workspace,
    tenantId: string,
    workspaceSlug: string,
    configuredRpc: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    for (const network of handle.networks) {
      const current = String(network.rpcUrl ?? '');
      if (!current) continue;

      let target: string;
      let source: RpcSource;
      try {
        const capability = this.inspectStored(current, tenantId, workspaceSlug);
        target = capability.target;
        source = capability.source;
      } catch {
        target = parseRpcTarget(current).href;
        const slug = String(network.slug);
        const configured = configuredRpc[slug];
        const builtin = BUILTIN_URL.get(slug);
        source = configured !== undefined && canonicalUrl(configured) === target
          ? 'tenant'
          : builtin !== undefined && builtin === target
            ? 'builtin'
            : 'tenant';
        // Legacy tenant URLs predate the boundary. Revalidate them before the
        // singleton is published; built-ins remain request-time checked.
        if (source === 'tenant') await this.resolvePublic(new URL(target).hostname);
      }

      const hardened = this.relayUrl(target, tenantId, workspaceSlug, source);
      if (hardened !== current) {
        try {
          await handle.networks.update(new Network({ ...network, rpcUrl: hardened }));
          this.rebindNetwork(handle, String(network.slug));
          this.revokeCapability(current);
        } catch (err) {
          this.revokeCapability(hardened);
          throw err;
        }
      }
    }
  }

  /** Rebind stale Address snapshots to the authoritative registry Network. */
  rebindNetwork(handle: Workspace, slug: string): void {
    const authoritative = handle.networks.bySlug(slug as never);
    if (!authoritative) throw new Error(`network ${slug} disappeared during update`);
    for (const account of handle.accounts) {
      for (const wallet of account.wallets) {
        for (const address of wallet.addresses) {
          if (String(address.network.slug) !== slug) continue;
          (address as unknown as { network: Network }).network = authoritative;
        }
      }
    }
  }

  private inspectStored(url: string, tenantId: string, workspaceSlug: string): Capability {
    const encoded = relayToken(url, null, false);
    if (!encoded) throw rejectedEndpoint();
    const capability = this.open(encoded);
    if (
      capability.tenantId !== tenantId ||
      capability.workspaceSlug !== workspaceSlug
    ) {
      throw rejectedEndpoint();
    }
    parseRpcTarget(capability.target);
    return capability;
  }

  private seal(payload: Capability): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(CAPABILITY_AAD);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  }

  private open(encoded: string): Capability {
    try {
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== encoded) throw new Error('encoding');
      const nonce = bytes.subarray(0, 12);
      const tag = bytes.subarray(12, 28);
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(CAPABILITY_AAD);
      decipher.setAuthTag(tag);
      const value = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      ) as Partial<Capability>;
      if (
        value.v !== 1 ||
        typeof value.tenantId !== 'string' ||
        typeof value.workspaceSlug !== 'string' ||
        typeof value.target !== 'string' ||
        !['tenant', 'builtin'].includes(String(value.source))
      ) {
        throw new Error('payload');
      }
      return value as Capability;
    } catch {
      throw rejectedEndpoint();
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.shuttingDown || this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      writeRelayError(res);
      return;
    }
    this.activeRequests += 1;
    let outboundController: AbortController | null = null;
    let outboundWorkspaceKey: string | null = null;
    try {
      if (req.method !== 'POST' || !req.url) throw new Error('invalid relay request');
      const path = new URL(req.url, 'http://relay.invalid');
      const match = /^\/rpc\/([A-Za-z0-9_-]+)$/.exec(path.pathname);
      if (!match || path.search || path.hash) throw new Error('invalid relay capability');
      const capability = this.open(match[1]);
      const active = this.activeCapabilities.get(
        capabilityWorkspaceKey(capability.tenantId, capability.workspaceSlug),
      );
      if (!active?.has(match[1])) throw new Error('inactive relay capability');
      const workspaceKey = capabilityWorkspaceKey(capability.tenantId, capability.workspaceSlug);
      if ((this.workspaceAbortBlocks.get(workspaceKey) ?? 0) > 0) {
        throw new Error('RPC operation is no longer active');
      }
      outboundController = new AbortController();
      outboundWorkspaceKey = workspaceKey;
      this.outboundAborts.set(outboundController, workspaceKey);
      outboundController.signal.addEventListener('abort', () => req.destroy(), { once: true });
      const body = await readRequest(req);
      if (outboundController.signal.aborted) throw new Error('RPC operation was aborted');
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      if (parsed === null || (typeof parsed !== 'object')) throw new Error('invalid JSON-RPC body');

      const upstream = await this.forward(capability, body, outboundController);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', upstream.length);
      res.setHeader('cache-control', 'no-store');
      res.end(upstream);
    } catch {
      writeRelayError(res);
    } finally {
      if (outboundController) this.outboundAborts.delete(outboundController);
      if (outboundWorkspaceKey) this.resolveWorkspaceDrain(outboundWorkspaceKey);
      this.activeRequests -= 1;
      if (this.activeRequests === 0 && this.resolveShutdownDrain) {
        this.resolveShutdownDrain();
        this.resolveShutdownDrain = null;
        this.shutdownDrain = null;
      }
    }
  }

  private async forward(
    capability: Capability,
    body: Buffer,
    controller: AbortController,
  ): Promise<Buffer> {
    if (body.length > MAX_REQUEST_BYTES) throw new Error('RPC request too large');
    const target = parseRpcTarget(capability.target);
    const startedAt = Date.now();
    const addresses = await withAbort(this.resolvePublic(target.hostname), controller.signal);
    if (this.shuttingDown) throw new Error('RPC boundary is shutting down');
    if (controller.signal.aborted) throw new Error('RPC operation was aborted during resolution');
    const selected = addresses[0];
    const remaining = Math.max(1, REQUEST_TIMEOUT_MS - (Date.now() - startedAt));

    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => controller.abort(), remaining);
      timer.unref();
      const settle = <T>(fn: (value: T) => void, value: T): void => {
        clearTimeout(timer);
        fn(value);
      };
      if (this.shuttingDown) {
        settle(reject, new Error('RPC boundary is shutting down'));
        return;
      }
      const request = this.requester(target, {
        method: 'POST',
        agent: false,
        signal: controller.signal,
        maxHeaderSize: MAX_HEADER_BYTES,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': body.length,
          host: target.host,
        },
        lookup: pinnedLookup(selected),
      }, (response) => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          response.resume();
          settle(reject, new Error('RPC returned a non-success status'));
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          response.destroy();
          settle(reject, new Error('RPC response too large'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('RPC response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', (err) => settle(reject, err));
        response.once('end', () => {
          try {
            const result = Buffer.concat(chunks, size);
            const parsed = JSON.parse(result.toString('utf8')) as unknown;
            if (parsed === null || typeof parsed !== 'object') throw new Error('invalid JSON');
            settle(resolve, result);
          } catch (err) {
            settle(reject, err);
          }
        });
      });
      request.once('error', (err) => settle(reject, err));
      request.end(body);
    });
  }

  private async resolvePublic(hostname: string): Promise<readonly PublicAddress[]> {
    const host = stripBrackets(hostname);
    const literalFamily = isIP(host);
    const records = literalFamily
      ? [{ address: host, family: literalFamily as 4 | 6 }]
      : await withTimeout(this.dnsResolver(host), DNS_TIMEOUT_MS);
    if (records.length === 0) throw rejectedEndpoint();
    const addresses = records.map((record): PublicAddress => ({
      address: record.address,
      family: record.family,
    }));
    if (
      addresses.some(
        (record) =>
          isIP(record.address) !== record.family || !isGlobalRpcAddress(record.address),
      )
    ) {
      throw rejectedEndpoint();
    }
    return addresses;
  }

  private resolveWorkspaceDrain(key: string): void {
    if ([...this.outboundAborts.values()].includes(key)) return;
    const waiters = this.workspaceDrainWaiters.get(key);
    if (!waiters) return;
    this.workspaceDrainWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }
}

export function pinnedLookup(selected: PublicAddress): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: Function,
  ): void => {
    if (options.all) {
      callback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }
    callback(null, selected.address, selected.family);
  }) as LookupFunction;
}

function capabilityWorkspaceKey(tenantId: string, workspaceSlug: string): string {
  return `${tenantId.length}:${tenantId}${workspaceSlug}`;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('RPC operation was aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('RPC operation was aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function relayToken(
  raw: string,
  currentOrigin: string | null,
  requireCurrentOrigin: boolean,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (requireCurrentOrigin && (!currentOrigin || parsed.origin !== currentOrigin))
  ) {
    return null;
  }
  return /^\/rpc\/([A-Za-z0-9_-]+)$/.exec(parsed.pathname)?.[1] ?? null;
}

function rejectedEndpoint(): TeeError {
  return new TeeError('TEE_RPC_UNSAFE', 'RPC endpoint is not permitted');
}

function canonicalUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

export function parseRpcTarget(raw: string): URL {
  if (Buffer.byteLength(raw, 'utf8') > MAX_TARGET_URL_BYTES) throw rejectedEndpoint();
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw rejectedEndpoint();
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.hash ||
    !target.hostname
  ) {
    throw rejectedEndpoint();
  }
  const literal = stripBrackets(target.hostname);
  if (isIP(literal) !== 0 && !isGlobalRpcAddress(literal)) throw rejectedEndpoint();
  return target;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function isGlobalRpcAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes || (bytes[0] & 0xe0) !== 0x20) return false; // strict global-unicast 2000::/3
  if (hasPrefix(bytes, [0x20, 0x01, 0x00], 23)) return false; // IETF special-purpose space
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false; // documentation
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return false; // 6to4 embeds IPv4
  if (hasPrefix(bytes, [0x3f, 0xff, 0x00], 20)) return false; // documentation
  return true;
}

function ipv6Bytes(address: string): Uint8Array | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] => {
    if (!side) return [];
    const parts = side.split(':');
    const words: number[] = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
          return [];
        }
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        const word = Number.parseInt(part, 16);
        if (!/^[0-9a-f]{1,4}$/.test(part) || !Number.isFinite(word)) return [];
        words.push(word);
      }
    }
    return words;
  };
  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) return null;
  const bytes = new Uint8Array(16);
  words.forEach((word, i) => {
    bytes[i * 2] = word >> 8;
    bytes[i * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function hasPrefix(address: Uint8Array, prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 1) {
    const byte = Math.floor(bit / 8);
    const mask = 1 << (7 - (bit % 8));
    if ((address[byte] & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

async function readRequest(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error('request too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function writeRelayError(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'RPC unavailable' },
    }),
  );
  res.statusCode = 502;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', body.length);
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(rejectedEndpoint()), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch {
    throw rejectedEndpoint();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
