import { KDF_PROBE_RUNNER, KdfCheckService } from '../../src/kdf/kdf-check.service';
import { boot, type Harness } from '../harness/boot';

describe('kdf-backend-flow', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  it('never runs the production timing probe under NODE_ENV=test', async () => {
    harness = await boot();
    const app = harness.app;
    expect(app.get(KdfCheckService).status).toBeNull();
    // AppModule's production provider is skipped before invocation in test mode.
    // The token remains resolvable, which also catches accidental provider removal.
    expect(app.get(KDF_PROBE_RUNNER)).toBeDefined();
  });
});
