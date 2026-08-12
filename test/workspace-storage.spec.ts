import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HybridProviderV3, Workspace } from 'wative-core';
import type { Paths } from '../src/config/paths';
import { WorkspaceStorageService } from '../src/workspaces/workspace-storage.service';

const PASSWORD = 'password123';

describe('WorkspaceStorageService existing-only boundary', () => {
  let baseDir: string;
  let dataRoot: string;
  let workspaceDir: string;
  let storage: WorkspaceStorageService;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'tee-storage-test-'));
    dataRoot = join(baseDir, 'data');
    workspaceDir = join(dataRoot, 'acme', 'desk-a');
    storage = new WorkspaceStorageService({ dataRoot } as Paths);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(baseDir, { recursive: true, force: true });
  });

  async function provision(): Promise<void> {
    const workspace = await Workspace.open({ path: workspaceDir, password: PASSWORD });
    await workspace.lock();
  }

  it('opens a complete existing container without changing its layout', async () => {
    await provision();
    const before = readdirSync(workspaceDir).sort();
    let handedOff: Workspace | undefined;

    const workspace = await storage.openExisting('acme', 'desk-a', PASSWORD, (handle) => {
      handedOff = handle;
    });

    expect(workspace).toBe(handedOff);
    expect(readdirSync(workspaceDir).sort()).toEqual(before);
    await workspace.lock();
  });

  it.each([
    ['absent', () => undefined],
    ['empty', () => mkdirSync(workspaceDir, { recursive: true })],
    [
      'foreign',
      () => {
        mkdirSync(workspaceDir, { recursive: true });
        writeFileSync(join(workspaceDir, 'sentinel'), 'foreign');
      },
    ],
  ])('rejects %s storage without creating or changing it', async (_kind, arrange) => {
    arrange();
    const before = existsSync(workspaceDir) ? readdirSync(workspaceDir).sort() : null;

    await expect(
      storage.openExisting('acme', 'desk-a', PASSWORD, () => undefined),
    ).rejects.toMatchObject({ code: 'TEE_WORKSPACE_NOT_FOUND' });

    expect(existsSync(workspaceDir) ? readdirSync(workspaceDir).sort() : null).toEqual(before);
  });

  it('fails closed on a partial container instead of regenerating records', async () => {
    await provision();
    rmSync(join(workspaceDir, 'network'));
    const configBefore = readFileSync(join(workspaceDir, 'config'));

    await expect(
      storage.openExisting('acme', 'desk-a', PASSWORD, () => undefined),
    ).rejects.toMatchObject({ code: 'PROVIDER_IO' });

    expect(existsSync(join(workspaceDir, 'network'))).toBe(false);
    expect(readFileSync(join(workspaceDir, 'config'))).toEqual(configBefore);
  });

  it('preserves bad-password semantics for a valid container', async () => {
    await provision();
    await expect(
      storage.openExisting('acme', 'desk-a', 'wrong-password', () => undefined),
    ).rejects.toMatchObject({ code: 'BAD_PASSWORD' });

    const workspace = await storage.openExisting('acme', 'desk-a', PASSWORD, () => undefined);
    await workspace.lock();
  });

  it('rejects workspace symlinks without touching their target', async () => {
    const target = join(baseDir, 'outside');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'sentinel'), 'keep');
    mkdirSync(join(dataRoot, 'acme'), { recursive: true });
    symlinkSync(target, workspaceDir, 'dir');

    await expect(
      storage.openExisting('acme', 'desk-a', PASSWORD, () => undefined),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(storage.remove('acme', 'desk-a')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('does not initialize storage removed after inspection but before core open', async () => {
    await provision();
    const original = HybridProviderV3.prototype.inspectContainer;
    jest
      .spyOn(HybridProviderV3.prototype, 'inspectContainer')
      .mockImplementationOnce(async function (this: HybridProviderV3) {
        const state = await original.call(this);
        rmSync(workspaceDir, { recursive: true, force: true });
        return state;
      });

    await expect(
      storage.openExisting('acme', 'desk-a', PASSWORD, () => undefined),
    ).rejects.toMatchObject({ code: 'PROVIDER_IO' });
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it('fails when an inspection provider cannot close', async () => {
    await provision();
    jest
      .spyOn(HybridProviderV3.prototype, 'close')
      .mockRejectedValueOnce(new Error('inspection close probe'));

    await expect(storage.assertExisting('acme', 'desk-a')).rejects.toMatchObject({
      code: 'PROVIDER_IO',
    });
  });

  it('detects a valid root replacement after core open', async () => {
    await provision();
    const replacement = join(dataRoot, 'acme', 'replacement');
    const other = await Workspace.open({ path: replacement, password: PASSWORD });
    await other.lock();
    const displaced = join(dataRoot, 'acme', 'displaced');
    let opened: Workspace | undefined;

    await expect(
      storage.openExisting('acme', 'desk-a', PASSWORD, (handle) => {
        opened = handle;
        renameSync(workspaceDir, displaced);
        renameSync(replacement, workspaceDir);
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_IO' });
    await opened?.lock();
  });

  it.each(['root', 'tenant', 'config'] as const)(
    'rejects a %s symlink without touching its target',
    async (kind) => {
      const target = join(baseDir, `outside-${kind}`);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'sentinel'), 'keep');

      if (kind === 'root') {
        symlinkSync(target, dataRoot, 'dir');
      } else if (kind === 'tenant') {
        mkdirSync(dataRoot, { recursive: true });
        symlinkSync(target, join(dataRoot, 'acme'), 'dir');
      } else {
        await provision();
        rmSync(join(workspaceDir, 'config'));
        symlinkSync(join(target, 'sentinel'), join(workspaceDir, 'config'));
      }

      const expectedCode = kind === 'config' ? 'PROVIDER_IO' : 'PERMISSION_DENIED';
      await expect(
        storage.openExisting('acme', 'desk-a', PASSWORD, () => undefined),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep');
    },
  );
});
