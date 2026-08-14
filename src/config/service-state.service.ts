import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ServiceStateSchema, type ServiceState, type TenantState } from './schemas';
import type { Paths } from './paths';

const INITIALIZED_MARKER = 'tee-docker-state-v1\n';
const LOCK_VERSION = 1;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ServiceStateFs {
  mkdir(path: string, options: { recursive: true; mode: number }): void;
  chmod(path: string, mode: number): void;
  lstat(path: string): Stats;
  fstat(fd: number): Stats;
  fchmod(fd: number, mode: number): void;
  read(path: string): string;
  readdir(path: string): string[];
  openExclusive(path: string, mode: number): number;
  write(fd: number, bytes: string): void;
  fsync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  openDirectory(path: string): number;
}

export const NODE_SERVICE_STATE_FS: ServiceStateFs = {
  mkdir: (path, options) => mkdirSync(path, options),
  chmod: (path, mode) => chmodSync(path, mode),
  lstat: (path) => lstatSync(path),
  fstat: (fd) => fstatSync(fd),
  fchmod: (fd, mode) => fchmodSync(fd, mode),
  read: (path) => readFileSync(path, 'utf8'),
  readdir: (path) => readdirSync(path),
  openExclusive: (path, mode) => openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  ),
  write: (fd, bytes) => writeFileSync(fd, bytes, 'utf8'),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  openDirectory: (path) => openSync(path, 'r'),
};

interface StateFiles {
  readonly dir: string;
  readonly current: string;
  readonly backup: string;
  readonly marker: string;
  readonly lock: string;
}

interface ProcessLock {
  readonly fd: number;
  readonly path: string;
  readonly dir: string;
  readonly ownerId: string;
  readonly dev: number;
  readonly ino: number;
}

type Candidate =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly error: unknown }
  | { readonly kind: 'valid'; readonly state: ServiceState; readonly bytes: string };

/**
 * Machine-owned mutable state — workspace membership and wallet totals.
 *
 * Each commit durably installs the last confirmed snapshot as a backup before
 * atomically replacing the primary. File and parent-directory fsync barriers
 * make the rename ordering survive power loss on normal POSIX filesystems.
 */
@Injectable()
export class ServiceStateService {
  #state: ServiceState;
  #queue: Promise<unknown> = Promise.resolve();
  #poisoned: Error | null = null;
  #closing = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    private readonly paths: Paths,
    initial: ServiceState,
    private readonly fs: ServiceStateFs = NODE_SERVICE_STATE_FS,
    private readonly lock?: ProcessLock,
  ) {
    // Never retain a caller-owned graph as authoritative state.
    this.#state = ServiceStateSchema.parse(structuredClone(initial));
  }

  static fromFile(
    paths: Paths,
    fs: ServiceStateFs = NODE_SERVICE_STATE_FS,
  ): ServiceStateService {
    const files = stateFiles(paths);
    prepareDirectory(files, fs);
    const lock = acquireProcessLock(files, fs);

    try {
      sweepTemps(files, fs);

      const current = readCandidate(files.current, fs);
      const backup = readCandidate(files.backup, fs);
      const marker = readMarker(files.marker, fs);
      let state: ServiceState;

      if (current.kind === 'valid') {
        state = current.state;
        // Existing pre-M-02 installations acquire both recovery artifacts at
        // boot. A corrupt/missing backup is never trusted or copied forward.
        if (backup.kind !== 'valid') install(files, files.backup, current.bytes, 'bak', fs);
        if (!marker) install(files, files.marker, INITIALIZED_MARKER, 'initialized', fs);
      } else if (backup.kind === 'valid') {
        state = backup.state;
        install(files, files.current, backup.bytes, 'current', fs);
        if (!marker) install(files, files.marker, INITIALIZED_MARKER, 'initialized', fs);
      } else if (current.kind === 'missing' && backup.kind === 'missing' && !marker) {
        state = { tenants: {} };
        const bytes = serialize(state);
        install(files, files.backup, bytes, 'bak', fs);
        install(files, files.current, bytes, 'current', fs);
        install(files, files.marker, INITIALIZED_MARKER, 'initialized', fs);
      } else {
        throw new Error(`service state at ${paths.stateFile} has no valid recoverable snapshot`, {
          cause: current.kind === 'invalid' ? current.error : backup.kind === 'invalid' ? backup.error : undefined,
        });
      }

      return new ServiceStateService(paths, state, fs, lock);
    } catch (error) {
      try {
        releaseProcessLock(lock, fs);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'service state boot failed and its process lock could not be released',
        );
      }
      throw error;
    }
  }

  tenant(tenantId: string): TenantState {
    this.#assertHealthy();
    if (!Object.hasOwn(this.#state.tenants, tenantId)) {
      return { walletTotal: 0, workspaces: [] };
    }
    return structuredClone(this.#state.tenants[tenantId]);
  }

  /** Serialize a synchronous mutation and publish it only after durable commit. */
  async mutate<T>(fn: (state: ServiceState) => T): Promise<T> {
    // Admission happens before queuing so work accepted before shutdown is
    // drained, while work submitted after shutdown starts is rejected.
    this.#assertHealthy();
    const run = this.#queue.then(async () => {
      this.#assertNotPoisoned();
      const draft: ServiceState = structuredClone(this.#state);
      const result = fn(draft);
      if (isPromiseLike(result)) {
        throw new TypeError('service state mutation callback must be synchronous');
      }
      const validated = ServiceStateSchema.parse(draft);
      // Clone before persistence: an unclonable result must be a safe
      // pre-commit rejection, never a committed mutation that fails while
      // returning. This also detaches nested values returned from the draft.
      const safeResult = structuredClone(result);
      await this.#persist(validated);
      // A callback can retain its draft through a closure even when it returns
      // a primitive. Publish a second graph that the callback never observed.
      this.#state = structuredClone(validated);
      return safeResult;
    });

    // A safe pre-commit failure does not wedge the queue. An indeterminate
    // post-rename failure poisons the instance and every later operation fails.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Drain queued state work and release the lifetime single-process lock. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#queue;
      if (this.lock) releaseProcessLock(this.lock, this.fs);
    })();
    return this.#closePromise;
  }

  async #persist(state: ServiceState): Promise<void> {
    const files = stateFiles(this.paths);
    let currentRenamed = false;
    try {
      install(files, files.backup, serialize(this.#state), 'bak', this.fs);
      const temp = durableTemp(files, serialize(state), 'current', this.fs);
      const previous = this.fs.lstat(files.current);
      try {
        this.fs.rename(temp, files.current);
        currentRenamed = true;
        syncDirectory(files.dir, this.fs);
      } catch (error) {
        // A filesystem adapter or kernel boundary can complete rename and then
        // report failure. An inode change means the primary may already be the
        // new snapshot, so continuing from old memory would risk overwriting
        // an indeterminate commit. If inspection itself fails, also fail closed.
        if (!currentRenamed) {
          try {
            const after = this.fs.lstat(files.current);
            currentRenamed = after.dev !== previous.dev || after.ino !== previous.ino;
          } catch {
            currentRenamed = true;
          }
        }
        cleanupTemp(temp, this.fs);
        throw error;
      }
    } catch (error) {
      if (currentRenamed) {
        this.#poisoned = new Error('service state commit outcome is indeterminate; restart required', {
          cause: error,
        });
        throw this.#poisoned;
      }
      throw error;
    }
  }

  #assertHealthy(): void {
    if (this.#closing) throw new Error('service state is closing');
    this.#assertNotPoisoned();
  }

  #assertNotPoisoned(): void {
    if (this.#poisoned) throw this.#poisoned;
  }
}

function stateFiles(paths: Paths): StateFiles {
  return {
    dir: dirname(paths.stateFile),
    current: paths.stateFile,
    backup: `${paths.stateFile}.bak`,
    marker: `${paths.stateFile}.initialized`,
    lock: `${paths.stateFile}.lock`,
  };
}

function acquireProcessLock(files: StateFiles, fs: ServiceStateFs): ProcessLock {
  const ownerId = randomUUID();
  let fd: number;
  try {
    fd = fs.openExclusive(files.lock, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      assertExistingLock(files.lock, fs);
      throw new Error(
        'service state is already locked; if the prior process crashed, verify it is stopped and remove the lock manually',
        { cause: error },
      );
    }
    throw error;
  }

  let lock: ProcessLock | undefined;
  try {
    const created = fs.fstat(fd);
    lock = {
      fd,
      path: files.lock,
      dir: files.dir,
      ownerId,
      dev: created.dev,
      ino: created.ino,
    };
    if (!created.isFile() || created.nlink !== 1) {
      throw new Error('new service state lock is not a private regular file');
    }
    fs.fchmod(fd, 0o600);
    fs.write(fd, `${JSON.stringify({
      version: LOCK_VERSION,
      ownerId,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    })}\n`);
    fs.fsync(fd);
    syncDirectory(files.dir, fs);
    assertHeldLock(lock, fs, true);
    return lock;
  } catch (error) {
    try {
      lock ??= lockFromFd(fd, files, ownerId, fs);
      releaseProcessLock(lock, fs, false);
    } catch (releaseError) {
      try { fs.close(fd); } catch { /* aggregate keeps the cleanup failure */ }
      throw new AggregateError(
        [error, releaseError],
        'service state lock acquisition failed and partial lock cleanup failed',
      );
    }
    throw error;
  }
}

function lockFromFd(
  fd: number,
  files: StateFiles,
  ownerId: string,
  fs: ServiceStateFs,
): ProcessLock {
  const held = fs.fstat(fd);
  return {
    fd,
    path: files.lock,
    dir: files.dir,
    ownerId,
    dev: held.dev,
    ino: held.ino,
  };
}

function assertExistingLock(path: string, fs: ServiceStateFs): void {
  const stats = fs.lstat(path);
  if (
    !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error('existing service state lock is not a private regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.read(path));
  } catch (error) {
    throw new Error('existing service state lock metadata is invalid', { cause: error });
  }
  if (!isLockMetadata(parsed)) {
    throw new Error('existing service state lock metadata is invalid');
  }
}

function isLockMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lock = value as Record<string, unknown>;
  if (Object.keys(lock).sort().join(',') !== 'acquiredAt,hostname,ownerId,pid,version') return false;
  return lock.version === LOCK_VERSION &&
    typeof lock.ownerId === 'string' && UUID_V4_RE.test(lock.ownerId) &&
    typeof lock.pid === 'number' && Number.isSafeInteger(lock.pid) && lock.pid > 0 &&
    typeof lock.hostname === 'string' && lock.hostname.length > 0 && lock.hostname.length <= 255 &&
    typeof lock.acquiredAt === 'string' && isExactIsoDate(lock.acquiredAt);
}

function isExactIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function releaseProcessLock(
  lock: ProcessLock,
  fs: ServiceStateFs,
  verifyMetadata = true,
): void {
  try {
    assertHeldLock(lock, fs, verifyMetadata);
    // Probe both fallible release primitives while the pathname still excludes
    // contenders. Unlink is the final release boundary; after it succeeds,
    // another process may safely acquire even if this process exits before a
    // second directory durability barrier would complete.
    syncDirectory(lock.dir, fs);
    fs.close(lock.fd);
  } catch (error) {
    try { fs.close(lock.fd); } catch { /* metadata error remains primary */ }
    throw new Error('service state lock release failed; lock retained', { cause: error });
  }
  try {
    fs.unlink(lock.path);
  } catch (error) {
    // Some adapters/filesystems can complete unlink and then surface an error.
    // A missing path means exclusion was successfully released; otherwise the
    // retained pathname continues to block contenders and the failure stands.
    try {
      fs.lstat(lock.path);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return;
    }
    throw error;
  }
}

function assertHeldLock(
  lock: ProcessLock,
  fs: ServiceStateFs,
  verifyMetadata: boolean,
): void {
  const held = fs.fstat(lock.fd);
  const current = fs.lstat(lock.path);
  if (
    !held.isFile() || held.nlink !== 1 || (held.mode & 0o777) !== 0o600 ||
    current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 ||
    (current.mode & 0o777) !== 0o600 ||
    held.dev !== lock.dev || held.ino !== lock.ino ||
    current.dev !== lock.dev || current.ino !== lock.ino
  ) {
    throw new Error('service state lock ownership changed; refusing to remove it');
  }
  if (!verifyMetadata) return;
  const metadata: unknown = JSON.parse(fs.read(lock.path));
  if (!isLockMetadata(metadata) || (metadata as { ownerId: string }).ownerId !== lock.ownerId) {
    throw new Error('service state lock ownership changed; refusing to remove it');
  }
}

function prepareDirectory(files: StateFiles, fs: ServiceStateFs): void {
  fs.mkdir(files.dir, { recursive: true, mode: 0o700 });
  const stats = fs.lstat(files.dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`service state directory ${files.dir} is not trusted`);
  }
  fs.chmod(files.dir, 0o700);
}

function readCandidate(path: string, fs: ServiceStateFs): Candidate {
  const stats = safeLstat(path, fs);
  if (!stats) return { kind: 'missing' };
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`service state candidate ${path} is not a regular file`);
  }
  fs.chmod(path, 0o600);
  let bytes: string;
  try {
    bytes = fs.read(path);
  } catch (error) {
    return { kind: 'invalid', error };
  }
  try {
    const state = ServiceStateSchema.parse(JSON.parse(bytes));
    return { kind: 'valid', state, bytes: serialize(state) };
  } catch (error) {
    return { kind: 'invalid', error };
  }
}

function readMarker(path: string, fs: ServiceStateFs): boolean {
  const stats = safeLstat(path, fs);
  if (!stats) return false;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`service state marker ${path} is not a regular file`);
  }
  fs.chmod(path, 0o600);
  if (fs.read(path) !== INITIALIZED_MARKER) {
    throw new Error(`service state marker ${path} is invalid`);
  }
  return true;
}

function safeLstat(path: string, fs: ServiceStateFs): Stats | null {
  try {
    return fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function install(
  files: StateFiles,
  target: string,
  bytes: string,
  kind: 'current' | 'bak' | 'initialized',
  fs: ServiceStateFs,
): void {
  const temp = durableTemp(files, bytes, kind, fs);
  try {
    fs.rename(temp, target);
    syncDirectory(files.dir, fs);
  } catch (error) {
    cleanupTemp(temp, fs);
    throw error;
  }
}

function durableTemp(
  files: StateFiles,
  bytes: string,
  kind: 'current' | 'bak' | 'initialized',
  fs: ServiceStateFs,
): string {
  const suffix = kind === 'current' ? 'tmp' : `${kind}.tmp`;
  const path = `${files.current}.${suffix}-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openExclusive(path, 0o600);
    fs.write(fd, bytes);
    fs.fsync(fd);
    fs.close(fd);
    fd = undefined;
    return path;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.close(fd); } catch { /* preserve the first failure */ }
    }
    cleanupTemp(path, fs);
    throw error;
  }
}

function syncDirectory(path: string, fs: ServiceStateFs): void {
  const fd = fs.openDirectory(path);
  try {
    fs.fsync(fd);
  } finally {
    fs.close(fd);
  }
}

function sweepTemps(files: StateFiles, fs: ServiceStateFs): void {
  const name = basename(files.current).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uuidV4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const owned = new RegExp(
    `^${name}\\.(?:tmp|bak\\.tmp|initialized\\.tmp)-\\d+-${uuidV4}$`,
  );
  let changed = false;
  for (const entry of fs.readdir(files.dir)) {
    if (!owned.test(entry)) continue;
    fs.unlink(join(files.dir, entry));
    changed = true;
  }
  if (changed) syncDirectory(files.dir, fs);
}

function cleanupTemp(path: string, fs: ServiceStateFs): void {
  try {
    fs.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Cleanup must not replace the durability failure that caused it.
    }
  }
}

function serialize(state: ServiceState): string {
  return `${JSON.stringify(ServiceStateSchema.parse(state), null, 2)}\n`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function';
}
