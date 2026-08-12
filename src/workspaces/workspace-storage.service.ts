import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  HybridProvider,
  HybridProviderV3,
  Workspace,
  WativeError,
  type ContainerState,
  type Provider,
} from 'wative-core';
import { TeeError } from '../common/tee-error';
import { PATHS, type Paths } from '../config/paths';
import { tenantRootPath, workspacePath } from './workspace-paths';

const REQUIRED_FILES = ['asset', 'config', 'log', 'network'] as const;
const REQUIRED_DIRECTORY = 'accounts';
const KNOWN_LAYOUT_NAMES = new Set<string>([...REQUIRED_FILES, REQUIRED_DIRECTORY]);

export interface WorkspaceStorageIdentity {
  readonly device: number;
  readonly inode: number;
  readonly realPath: string;
}

type ExistingOnlyProvider = Provider & {
  readonly rootPath: string;
  inspectContainer(): Promise<ContainerState>;
  close(): Promise<void>;
  enableWrites(): void;
};

/**
 * Filesystem boundary for tenant workspaces.
 *
 * Unlock is deliberately stricter than wative-core's general-purpose open:
 * the library may initialize an empty container, while this service may only
 * unlock storage that was provisioned through the tenant-tier create route.
 */
@Injectable()
export class WorkspaceStorageService {
  constructor(@Inject(PATHS) private readonly paths: Paths) {}

  async assertExisting(
    tenantId: string,
    workspaceSlug: string,
    expected?: WorkspaceStorageIdentity,
  ): Promise<WorkspaceStorageIdentity> {
    const path = workspacePath(this.paths.dataRoot, tenantId, workspaceSlug);
    const { identity, provider } = await this.preflight(path, tenantId);
    let validationError: unknown;
    try {
      if (expected && !sameIdentity(expected, identity)) {
        throw storageError('workspace storage changed while the singleton was active');
      }
    } catch (err) {
      validationError = err;
    }
    try {
      await provider.close();
    } catch (closeErr) {
      throw new WativeError('PROVIDER_IO', 'workspace inspection could not be closed', {
        cause: validationError
          ? new AggregateError([validationError, closeErr], 'validation and close failed')
          : closeErr,
      });
    }
    if (validationError) throw validationError;
    return identity;
  }

  async openExisting(
    tenantId: string,
    workspaceSlug: string,
    password: string,
    onOpened: (handle: Workspace, identity: WorkspaceStorageIdentity) => void,
  ): Promise<Workspace> {
    const path = workspacePath(this.paths.dataRoot, tenantId, workspaceSlug);
    const before = await this.assertLayout(path, tenantId);
    const provider = createExistingOnlyProvider(path);
    let handle: Workspace | undefined;
    let handedOff = false;

    try {
      const state = await provider.inspectContainer();
      if (state !== 'workspace') throw workspaceNotFound(workspaceSlug);

      // Passing an existing-only provider is essential. wative-core 2.4.4's
      // legacy `create=false` argument does not prevent empty-path creation.
      handle = await Workspace.open({ provider, password });
      // Hand ownership to SessionRegistry before the post-open identity check.
      // If that check fails, the registry can retain a closing tombstone when
      // locking the already-opened handle also fails.
      onOpened(handle, before);
      handedOff = true;
      const after = await this.assertLayout(path, tenantId);
      if (!sameIdentity(before, after)) {
        throw storageError('workspace storage changed while it was being unlocked');
      }
      provider.enableWrites();
      return handle;
    } catch (err) {
      if (handedOff) throw err;
      try {
        if (handle) await handle.lock();
        else await provider.close();
      } catch (closeErr) {
        throw new AggregateError([err, closeErr], 'failed to reject and lock changed workspace');
      }
      throw err;
    }
  }

  /** Remove a workspace without ever following a tenant or workspace symlink. */
  async remove(tenantId: string, workspaceSlug: string): Promise<void> {
    const root = resolve(this.paths.dataRoot);
    const tenantRoot = tenantRootPath(root, tenantId);
    const path = workspacePath(root, tenantId, workspaceSlug);

    const rootExists = await assertTrustedDirectoryIfPresent(root);
    if (!rootExists) return;
    const tenantExists = await assertTrustedDirectoryIfPresent(tenantRoot);
    if (!tenantExists) return;

    assertContained(root, tenantRoot);
    assertContained(tenantRoot, path);

    let workspaceStat;
    try {
      workspaceStat = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw storageError('workspace storage could not be inspected');
    }
    if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
      throw untrustedStorage();
    }

    await rm(path, { recursive: true, force: false }).catch((err: unknown) => {
      throw new WativeError('PROVIDER_IO', 'workspace storage could not be removed', {
        cause: err,
      });
    });
  }

  private async preflight(
    path: string,
    tenantId: string,
  ): Promise<{ identity: WorkspaceStorageIdentity; provider: ExistingOnlyProvider }> {
    const identity = await this.assertLayout(path, tenantId);
    const provider = createExistingOnlyProvider(path);
    try {
      const state = await provider.inspectContainer();
      if (state !== 'workspace') throw workspaceNotFound(path.split(sep).at(-1) ?? 'workspace');
      return { identity, provider };
    } catch (err) {
      try {
        await provider.close();
      } catch (closeErr) {
        throw new WativeError('PROVIDER_IO', 'workspace inspection could not be closed', {
          cause: new AggregateError([err, closeErr], 'inspection and close failed'),
        });
      }
      if (err instanceof TeeError) throw err;
      throw storageError('workspace storage could not be inspected');
    }
  }

  private async assertLayout(path: string, tenantId: string): Promise<WorkspaceStorageIdentity> {
    const root = resolve(this.paths.dataRoot);
    const tenantRoot = tenantRootPath(root, tenantId);
    assertContained(root, tenantRoot);
    assertContained(tenantRoot, path);

    const rootStat = await requiredDirectory(root, 'root');
    const tenantStat = await requiredDirectory(tenantRoot, 'tenant');
    const workspaceStat = await workspaceDirectory(path);
    if (rootStat.isSymbolicLink() || tenantStat.isSymbolicLink() || workspaceStat.isSymbolicLink()) {
      throw untrustedStorage();
    }

    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      throw storageError('workspace storage could not be inspected');
    }
    if (names.length === 0) throw workspaceNotFound(path.split(sep).at(-1) ?? 'workspace');
    if (!names.some((name) => KNOWN_LAYOUT_NAMES.has(name))) {
      throw workspaceNotFound(path.split(sep).at(-1) ?? 'workspace');
    }

    for (const name of REQUIRED_FILES) {
      const stat = await requiredEntry(resolve(path, name));
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw storageError('workspace storage layout is invalid');
      }
    }
    const accounts = await requiredEntry(resolve(path, REQUIRED_DIRECTORY));
    if (accounts.isSymbolicLink() || !accounts.isDirectory()) {
      throw storageError('workspace storage layout is invalid');
    }

    let canonicalRoot: string;
    let canonicalTenant: string;
    let canonicalWorkspace: string;
    try {
      [canonicalRoot, canonicalTenant, canonicalWorkspace] = await Promise.all([
        realpath(root),
        realpath(tenantRoot),
        realpath(path),
      ]);
    } catch {
      throw storageError('workspace storage could not be canonicalized');
    }
    assertContained(canonicalRoot, canonicalTenant);
    assertContained(canonicalTenant, canonicalWorkspace);

    return {
      device: workspaceStat.dev,
      inode: workspaceStat.ino,
      realPath: canonicalWorkspace,
    };
  }
}

abstract class ExistingOnlyWrites {
  protected writesEnabled = false;

  enableWrites(): void {
    this.writesEnabled = true;
  }

  get enabled(): boolean {
    return this.writesEnabled;
  }

  protected assertWritesEnabled(): void {
    if (!this.writesEnabled) {
      throw storageError('workspace initialization is not allowed during unlock');
    }
  }

  protected async assertDirectoryExists(path: string): Promise<void> {
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      throw storageError('workspace initialization is not allowed during unlock');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw untrustedStorage();
  }
}

class ExistingOnlyHybridProviderV3 extends HybridProviderV3 {
  private readonly guard = new ExistingOnlyGuard();

  enableWrites(): void {
    this.guard.enableWrites();
  }

  protected override async _write(path: string, data: Uint8Array): Promise<void> {
    this.guard.assertWritesEnabled();
    await super._write(path, data);
  }

  protected override async _remove(path: string): Promise<void> {
    this.guard.assertWritesEnabled();
    await super._remove(path);
  }

  protected override async _ensureDir(path: string): Promise<void> {
    if (!this.guard.enabled) await this.guard.assertDirectoryExists(path);
    await super._ensureDir(path);
  }
}

class ExistingOnlyHybridProvider extends HybridProvider {
  private readonly guard = new ExistingOnlyGuard();

  enableWrites(): void {
    this.guard.enableWrites();
  }

  protected override async _write(path: string, data: Uint8Array): Promise<void> {
    this.guard.assertWritesEnabled();
    await super._write(path, data);
  }

  protected override async _remove(path: string): Promise<void> {
    this.guard.assertWritesEnabled();
    await super._remove(path);
  }

  protected override async _ensureDir(path: string): Promise<void> {
    if (!this.guard.enabled) await this.guard.assertDirectoryExists(path);
    await super._ensureDir(path);
  }
}

class ExistingOnlyGuard extends ExistingOnlyWrites {
  override enableWrites(): void {
    super.enableWrites();
  }

  override get enabled(): boolean {
    return super.enabled;
  }

  override assertWritesEnabled(): void {
    super.assertWritesEnabled();
  }

  override async assertDirectoryExists(path: string): Promise<void> {
    await super.assertDirectoryExists(path);
  }
}

function createExistingOnlyProvider(path: string): ExistingOnlyProvider {
  try {
    return new ExistingOnlyHybridProviderV3(path);
  } catch {
    return new ExistingOnlyHybridProvider(path);
  }
}

async function requiredDirectory(path: string, kind: 'root' | 'tenant') {
  let stat;
  try {
    stat = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw workspaceNotFound(kind === 'root' ? 'workspace' : 'workspace');
    }
    throw storageError('workspace storage could not be inspected');
  }
  if (stat.isSymbolicLink()) throw untrustedStorage();
  if (!stat.isDirectory()) throw storageError('workspace storage layout is invalid');
  return stat;
}

async function workspaceDirectory(path: string) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw workspaceNotFound(path.split(sep).at(-1) ?? 'workspace');
    }
    throw storageError('workspace storage could not be inspected');
  }
  if (stat.isSymbolicLink()) throw untrustedStorage();
  if (!stat.isDirectory()) throw storageError('workspace storage layout is invalid');
  return stat;
}

async function requiredEntry(path: string) {
  try {
    return await lstat(path);
  } catch {
    throw storageError('workspace storage layout is incomplete');
  }
}

async function assertTrustedDirectoryIfPresent(path: string): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw storageError('workspace storage could not be inspected');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw untrustedStorage();
  return true;
}

function assertContained(parent: string, child: string): void {
  const rel = relative(parent, child);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(child) === resolve(parent)) {
    throw untrustedStorage();
  }
}

function sameIdentity(
  left: WorkspaceStorageIdentity,
  right: WorkspaceStorageIdentity,
): boolean {
  return (
    left.device === right.device && left.inode === right.inode && left.realPath === right.realPath
  );
}

function workspaceNotFound(slug: string): TeeError {
  return new TeeError('TEE_WORKSPACE_NOT_FOUND', `workspace "${slug}" not found`);
}

function storageError(message: string): WativeError {
  return new WativeError('PROVIDER_IO', message);
}

function untrustedStorage(): WativeError {
  return new WativeError('PERMISSION_DENIED', 'workspace storage path is not trusted');
}
