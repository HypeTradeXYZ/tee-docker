#!/usr/bin/env node
// Validate the operator config WITHOUT booting the service.
//
// Several config mistakes are refused at startup rather than repaired, which is
// the right call — a wallet service should not run on a half-understood config.
// But the file is a LIST: one bad tenant stops the process and takes every other
// tenant with it, and the trigger is a restart, not the edit that caused it. An
// unrelated deploy hours later is what surfaces the typo, as a crash loop.
//
// This gives that failure somewhere earlier to happen. Run it against a config
// before deploying it:
//
//   node scripts/check-config.mjs                    # config/tenants.json
//   node scripts/check-config.mjs path/to/tenants.json
//
// Exit 0 means the schema accepts it. It does NOT prove the service will boot:
// RPC endpoints are resolved over DNS at startup and the KDF backend is probed
// there too, neither of which happens here.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? 'config/tenants.json');

async function main() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(target, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Imported from the build so this validates with exactly the schema the
  // service runs, not a copy that can drift away from it.
  let TenantsConfigSchema;
  try {
    ({ TenantsConfigSchema } = await import('../dist/config/schemas.js'));
  } catch {
    throw new Error('run `pnpm build` first — this checks against the compiled schema');
  }

  const parsed = TenantsConfigSchema.safeParse(raw);
  if (parsed.success) {
    const count = parsed.data.tenants.length;
    process.stdout.write(`ok — ${count} tenant${count === 1 ? '' : 's'} accepted\n`);
    return;
  }

  // One line per problem, addressed by the path an operator can find in the
  // file. The service prints the raw issue array; this is the same information
  // shaped for someone holding the config open.
  process.stderr.write(`${target} would refuse to boot:\n\n`);
  for (const issue of parsed.error.issues) {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    process.stderr.write(`  ${where}\n    ${issue.message}\n`);
  }
  process.stderr.write('\nFix these before deploying; the service exits on any one of them.\n');
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
