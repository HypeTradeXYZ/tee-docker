#!/usr/bin/env node
// Compute a tenant's `secretHash` for the operator config.
//
// The hash is HMAC-SHA256 of the API secret under TEE_SECRET_HMAC_KEY, so it
// cannot be derived without that key — provisioning a tenant previously meant
// reading src/auth/secret.ts and reimplementing this by hand.
//
// Usage — prefer stdin; an argument is visible in `ps` and shell history:
//   printf %s "$API_SECRET" | TEE_SECRET_HMAC_KEY=<hex> node scripts/hash-secret.mjs
//   TEE_SECRET_HMAC_KEY=<hex> node scripts/hash-secret.mjs <api-secret>
//
// Generate a server key with:
//   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

import { createHmac } from 'node:crypto';

const MIN_KEY_BYTES = 16;

function serverKey() {
  const raw = process.env.TEE_SECRET_HMAC_KEY;
  if (!raw) {
    throw new Error('TEE_SECRET_HMAC_KEY is not set; it must match the running service.');
  }
  const key = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'utf8');
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(`TEE_SECRET_HMAC_KEY is too short (${key.length} bytes, need >= ${MIN_KEY_BYTES}).`);
  }
  return key;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main() {
  const secret = process.argv[2] ?? (process.stdin.isTTY ? '' : await readStdin());
  if (!secret) {
    throw new Error('usage: hash-secret <api-secret>   (or pipe the secret on stdin)');
  }
  // A secret is hashed here as UTF-8, but the service reads it out of an HTTP
  // header, and headers decode as latin1. For anything outside ASCII the two
  // encodings disagree, so whether such a secret authenticates depends on how
  // the caller's HTTP client happens to serialize the header — it works from
  // one client and fails from another, with a 401 that looks like a wrong key.
  // Refuse to mint the ambiguity rather than leave it to be discovered later.
  if (/[^\x20-\x7E]/.test(secret)) {
    throw new Error(
      'API secret must be printable ASCII (0x20-0x7E). Non-ASCII authenticates from '
        + 'some HTTP clients and not others, because header values decode as latin1 '
        + 'while this hash is UTF-8. Generate one with: '
        + "node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  // An HTTP parser strips leading and trailing whitespace from a header value,
  // so a secret with an outer space hashes to something NO client can ever
  // send — a permanent 401 from every caller, which is worse than the
  // encoding ambiguity above. Interior spaces are fine and stay allowed.
  if (/^\s|\s$/.test(secret)) {
    throw new Error(
      'API secret must not begin or end with whitespace. HTTP strips it from the '
        + 'header, so the service would compute a different hash than this one and '
        + 'every request would be refused. Check for a stray space when pasting.',
    );
  }
  // Only the hash reaches stdout, so this tool never echoes the secret. It
  // cannot undo an argv-passed secret already being in `ps` and history —
  // hence the stdin form above.
  process.stdout.write(`${createHmac('sha256', serverKey()).update(secret, 'utf8').digest('hex')}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
