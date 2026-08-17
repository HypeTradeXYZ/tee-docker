# TEE Docker

TEE Docker is a HTTP service for creating and using managed wallet workspaces. It gives an
application one consistent API for accounts, wallets, addresses, signing, transactions,
and optional encrypted key export.

This guide is for application developers, integrators, operators, and reviewers. You do NOT need
to understand wallet storage internals to use the service.

## The basic idea

- A **tenant** is a team or application with its own API credentials and usage limits.
- A **workspace**([Wative Workspace](https://github.com/braady/wative-core#workspace--open--unlock--lock)) is a password-protected collection of accounts and wallets.
- A **workspace token** opens one workspace for a limited time.
- A token has permissions called **scopes**: `read`, `write`, `sign`, and optional `export`.
- An **account** contains wallets; wallets contain addresses used for balances and transactions.

Tenant credentials are used only for workspace administration and requesting workspace tokens.
Most day-to-day API calls use a workspace token.

## Quick start

You need Node.js 22.12 or newer and pnpm / npm 11.

1. Install the project:

   ```bash
   pnpm install
   ```

2. Create local configuration from the examples:

   ```bash
   cp .env.example .env.local
   cp config/tenants.example.json config/tenants.json
   ```

3. Ask your platform or security owner for a local server key and matching tenant credentials.
   Put the server key in `.env.local` as `TEE_SECRET_HMAC_KEY`, and replace the placeholder tenant
   values in `config/tenants.json`. Do not use the example credentials outside local development.

4. Start the service:

   ```bash
   pnpm start:dev
   ```

5. Check that it is running:

   ```bash
   curl http://localhost:3000/v1/health
   ```

   A healthy service responds with `{"status":"ok"}`.

Run one service instance for each paired state and workspace storage location.
Starting a second instance on the same storage is refused to protect wallet and
quota records.

Before sharing a deployment, run:

```bash
pnpm verify
```

## Your first workspace

Set these placeholders to the credentials supplied by your operator:

```bash
API_URL=http://localhost:3000/v1
API_KEY=your-api-key
API_SECRET=your-api-secret
```

Create a workspace:

```bash
curl -X POST "$API_URL/workspaces" \
  -H "X-Api-Key: $API_KEY" \
  -H "X-Api-Secret: $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"slug":"demo","password":"choose-a-strong-workspace-password"}'
```

Request a workspace token:

```bash
curl -X POST "$API_URL/auth/token" \
  -H "X-Api-Key: $API_KEY" \
  -H "X-Api-Secret: $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"demo","password":"choose-a-strong-workspace-password"}'
```

Copy the returned `token`, then use it to inspect the workspace:

```bash
TOKEN=the-returned-token

curl "$API_URL/workspace" \
  -H "Authorization: Bearer $TOKEN"

curl "$API_URL/accounts" \
  -H "Authorization: Bearer $TOKEN"
```

Create an account:

```bash
curl -X POST "$API_URL/accounts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Main wallet","kind":"HD"}'
```

The service does not return a newly generated recovery phrase in plain text. Encrypted export must
be enabled by the operator and requested with an `export`-scoped token.

Account display names are cleaned before use and must be 4–64 characters afterward. The service
returns a lowercase account ID (`slug`) derived from the name; always save and use that returned
ID, because it may differ from the display name or include a numeric suffix when names collide.

## Key APIs

All routes use the `/v1` prefix.

| What you want to do | Method and path | Authentication |
|---|---|---|
| Check service health | `GET /health` | None |
| List or create workspaces | `GET/POST /workspaces` | Tenant credentials |
| View current usage limits | `GET /quota` | Tenant credentials |
| Request a workspace token | `POST /auth/token` | Tenant credentials |
| Refresh a token | `POST /auth/token/refresh` | Workspace token |
| Revoke a token | `DELETE /auth/token` | Workspace token |
| View the current workspace | `GET /workspace` | Workspace token |
| List or create accounts | `GET/POST /accounts` | Workspace token |
| View or remove an account | `GET/DELETE /accounts/:slug` | Workspace token |
| List, derive, or import wallets | `/accounts/:slug/wallets` | Workspace token |
| View addresses | `GET /accounts/:slug/wallets/:id/addresses` | Workspace token |
| Check balance availability (currently `501`) | `GET /addresses/:publicKey/balances` | Workspace token |
| View or update network endpoints | `/workspace/networks` | Workspace token |
| Sign a message | `POST /sign/message` | `sign` scope |
| Build, simulate, send, or check a transaction | `/transactions` | `sign` scope |
| Export an encrypted recovery phrase or private key | Account export routes | `export` scope |

The default workspace token includes `read`, `write`, and `sign`. Request `export` explicitly only
when the tenant has export enabled.
When exporting a private key, add `?vm=evm` or `?vm=svm`; the response repeats the selection.

## Common responses

Successful responses are JSON, except delete and lock operations that may return an empty success
response. Errors use one predictable shape:

```json
{
  "error": {
    "code": "account_not_found",
    "message": "...",
    "status": 404,
    "requestId": "..."
  }
}
```

Use `error.code` for application decisions. Keep `requestId` when asking an operator for help.
For requests accepted by the HTTP server, clients may send an `X-Request-ID` for tracing when it is 1–128 letters, digits, dots,
underscores, or hyphens. If it is missing or unsafe, the service creates a safe ID instead. The
same ID appears in the response header and error body.

Common situations include expired tokens (`session_expired`), missing permissions
(`scope_denied`), usage limits, unavailable network providers, and invalid request data.
For invalid requests, `invalid_slug` means a workspace or account ID has invalid syntax,
`invalid_body` means the JSON shape or field combination is wrong, and `invalid_parameter` means
a path or query selector is malformed. `unsupported_for_kind` means the selected account, wallet,
or chain type cannot perform that otherwise valid operation.

Transaction submission returns `pending` when the provider accepted it. If it returns `unknown`,
check `GET /v1/transactions/:hash?network=...` before sending again; the original transaction may
still have reached the network.

## Safe usage

- Never commit `.env.local`, `config/tenants.json`, workspace data, tokens, passwords, or exported
  wallet material.
- Treat a workspace token like a password until it expires or is revoked.
- Use the least-permissive token scopes your integration needs.
- Revoke a token with `DELETE /v1/auth/token` when a workflow is finished.
- Use `?force=true` when deleting an in-use workspace only if revoking its active tokens is intended.
- Keep network endpoint credentials and export setup with the service operator, not in client code.

## Useful commands

```bash
pnpm start:dev   # run locally and reload after changes
pnpm typecheck   # check TypeScript
pnpm test        # run tests
pnpm build       # create a production build
pnpm verify      # run all project checks
```

For most integrations, the workflow and API summary above are enough to get started.

Running it in production — including what to do when startup reports the state
directory is already locked — is covered in [docs/OPERATIONS.md](docs/OPERATIONS.md).
