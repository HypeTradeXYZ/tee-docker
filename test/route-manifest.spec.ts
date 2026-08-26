import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, type Harness } from './harness/boot';

/**
 * route-manifest — the published REST surface is a contract with the docs.
 *
 * Adding, renaming, or removing a route changes what integrators are told to
 * call, and the documentation is a separate repository that cannot notice on
 * its own. This test pins the route table so that divergence fails here,
 * where the change is being made, instead of silently in someone's client.
 *
 * Intentional changes are adopted with UPDATE_ROUTE_MANIFEST=1, which rewrites
 * the fixture. Doing so is the reminder to update the docs in the same pass —
 * the documentation site vendors a copy of this fixture and gates against it, so
 * a route added here is not published until that copy is refreshed:
 *
 *   pnpm vendor:routes   (run in the documentation repository)
 *
 * Its gate verifies the vendored copy against a stamp on every deploy, so a
 * stale copy cannot be quietly edited into agreement.
 */

const MANIFEST = join(__dirname, 'fixtures', 'route-manifest.json');

interface ExpressLayer {
  readonly route?: { readonly path?: unknown; readonly methods?: Record<string, boolean> };
}

/** Every routable METHOD + path the booted app actually serves, sorted. */
function routeTable(harness: Harness): string[] {
  const instance = harness.app.getHttpAdapter().getInstance() as Record<string, unknown>;
  // Express 5 exposes `router`; `_router` is the 4.x spelling kept for safety.
  const router = (instance.router ?? instance._router) as { stack?: ExpressLayer[] } | undefined;
  if (!router?.stack) throw new Error('could not read the Express router stack');

  const routes = new Set<string>();
  for (const layer of router.stack) {
    const path = layer.route?.path;
    if (typeof path !== 'string') continue;
    for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
      // Express registers an implicit HEAD beside every GET; it is not a route
      // anyone documents or calls deliberately.
      if (enabled && method !== 'head') routes.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return [...routes].sort();
}

describe('route-manifest', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await boot();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('serves exactly the routes the documentation describes', () => {
    const actual = routeTable(harness);

    if (process.env.UPDATE_ROUTE_MANIFEST === '1') {
      writeFileSync(MANIFEST, `${JSON.stringify(actual, null, 2)}\n`);
    }

    const expected: string[] = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const added = actual.filter((r) => !expected.includes(r));
    const removed = expected.filter((r) => !actual.includes(r));

    // Reported together, because a rename shows up as one of each and reading
    // them side by side is what makes it recognisable as a rename.
    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });

  it('keeps every route under the /v1 prefix', () => {
    expect(routeTable(harness).filter((r) => !r.includes(' /v1/'))).toEqual([]);
  });
});
