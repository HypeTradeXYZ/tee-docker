import { KdfCheckService } from '../../src/kdf/kdf-check.service';
import { boot, type Harness } from '../harness/boot';

/**
 * kdf-backend-flow — proves the boot probe reports which Argon2 implementation
 * resolved.
 *
 * @node-rs/argon2 is an OPTIONAL dependency of wative-core. A platform with no
 * prebuilt binary falls back silently, and the result is a service that is
 * perfectly correct and orders of magnitude too slow. Nothing else in the stack
 * catches that, so it is worth a flow of its own.
 */
describe('kdf-backend-flow', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  it('resolves a non-pure-JS backend on this platform', async () => {
    harness = await boot({ kdfCheck: true });
    const status = harness.app.get(KdfCheckService).status;

    expect(status).not.toBeNull();
    expect(status!.backends.length).toBeGreaterThan(0);
    expect(status!.backends).not.toContain('noble');
    expect(status!.safe).toBe(true);
  });

  it('reports a plausible probe cost', async () => {
    harness = await boot({ kdfCheck: true });
    const status = harness.app.get(KdfCheckService).status!;

    // A real Argon2id derivation is not free; a near-zero probe would mean the
    // KDF never ran and the check is proving nothing.
    expect(status.probeMs).toBeGreaterThan(5);
    // And on a working backend it must be far below the ~13s pure-JS path.
    expect(status.probeMs).toBeLessThan(5_000);
  });

  it('skips the probe when explicitly disabled', async () => {
    harness = await boot({ kdfCheck: false });
    expect(harness.app.get(KdfCheckService).status).toBeNull();
  });
});
