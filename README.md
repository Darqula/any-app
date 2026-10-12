# any-app

An LLM-driven web app builder, similar to Websim. You describe an app; the backend calls a model,
streams the generated app into the browser as it is produced, and saves it so it can be reopened,
edited region by region, shared and remixed. Generated apps are single self-contained HTML documents
and can store records through a small schemaless data API.

Design docs live in [`.docs/`](.docs/): start with [`overview.md`](.docs/overview.md), then
[`architecture.md`](.docs/architecture.md) for the locked design decisions.

## How it fits together

Two servers, on two deliberately separate origins:

- **studio** (`http://localhost:3000`): the trusted origin. UI, API, accounts, and the generation
  orchestrator. It is the only process that holds provider credentials.
- **sandbox** (port 3001): the untrusted origin. Serves each generated app from its own origin,
  `http://<app-id>.apps.localhost:3001`, proxies the live preview stream from the studio, and hosts
  the data API that generated apps call. It holds no provider credentials and no user sessions.

```
apps/studio/         studio server
apps/sandbox/        sandbox server (data API in src/data.ts)
packages/store/      Postgres pool (privileged role), migrations, generations, credentials
packages/records/    the `records` table behind the data API, on its own restricted role
packages/generator/  planner/fill/edit/router model calls, prompts, provider adapters
packages/protocol/   shell/slot document model, in-page runtimes, app tokens, view grants
packages/tsconfig/   shared TypeScript config
tests/               backend (node:test) and frontend (Playwright) suites
```

In development both apps run TypeScript directly through `tsx`; production runs the same code compiled by `tsc`
(`npm run build:server`, one `dist/` per workspace; see "Running in production"). The studio's view layer:
server-rendered pages from `apps/studio/src/views/` (an auto-escaping `html` tagged template owns every
interpolation), with stylesheets as plain static files under `apps/studio/public/css/`. The studio's browser
code is TypeScript in `apps/studio/client/`, bundled by esbuild into `apps/studio/dist/js/` with
`npm run build` (`npm run dev` rebuilds on change; `npm test` builds first; `npm run build:prod` compiles the
server too and minifies the bundle with no source maps).

## Setup

**Requirements:** Node.js 22 or newer (`engines` in `package.json`; `.nvmrc` names the major the suites run on), Docker, and a browser that resolves
`*.localhost` to loopback (Chrome, Edge and Firefox do; for Safari or restrictive DNS, see
`SANDBOX_APP_ORIGIN_TEMPLATE` below).

1. Install dependencies:
   ```sh
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in at least:
   - `DATABASE_URL`: the privileged connection (owner of the `anyapp` database).
   - `SANDBOX_DATABASE_URL`: the `anyapp_sandbox` connection. It falls back to `DATABASE_URL` so a
     fresh checkout boots, but that removes the sandbox's isolation.
   - `CREDENTIAL_KEY` and `APP_TOKEN_SECRET`: 32 random bytes each, base64. Both servers refuse to
     start without them:
     ```sh
     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     ```
   - `INTERNAL_SECRET`: shared secret for sandbox → studio calls.
   - Model settings and a provider key (see [Model configuration](#model-configuration)).
3. Start the database and finish its setup:
   ```sh
   npm run db
   ```
   Starts a dedicated `postgres:17` container (`anyapp-postgres`, defined in `compose.yaml`) on
   `DATABASE_URL`'s host and port, applies migrations, and creates or re-syncs the sandbox's
   restricted role from `SANDBOX_DATABASE_URL`. Everything is idempotent, so it is safe to re-run
   any time. If another postgres already binds the port, change the port in both URLs (the compose
   default is 5432); the data lives in the `anyapp_pgdata` docker volume.
4. Start both servers and open `http://localhost:3000` (this runs `npm run db` first, so an already
   filled-in `.env` needs just this step):
   ```sh
   npm run dev
   ```

Without Docker, set `ANYAPP_DB_AUTOSTART=0` and point the URLs at any PostgreSQL you manage:
create an empty database, apply migrations with `npm run migrate`, and create the sandbox's
restricted role with the password from `SANDBOX_DATABASE_URL`. It may touch the `records` table
and nothing else; never give it a broader grant such as `on all tables`:
```sql
create role anyapp_sandbox login password 'choose-one';
grant usage on schema public to anyapp_sandbox;
grant select, insert, update, delete on records to anyapp_sandbox;
```

`npm run dev` restarts a server when a `.ts` file changes, but `.env` is read only once at startup:
after editing `.env`, stop and restart `npm run dev`.

### Origins

- `STUDIO_PUBLIC_URL` must be the exact origin your browser shows for the studio.
  `http://localhost:3000` and `http://127.0.0.1:3000` are different origins, and the in-page runtime
  silently rejects messages from the wrong one.
- `SANDBOX_APP_ORIGIN_TEMPLATE` (default `http://{id}.apps.localhost:3001`) gives every generated app
  its own origin, so apps cannot read each other's storage or data-API tokens. Keep `{id}` in it. If
  `*.localhost` does not resolve for you, use hosts entries or a wildcard DNS service such as
  `http://{id}.127.0.0.1.nip.io:3001`.

## Model configuration

The studio makes four kinds of model calls, called *roles*:

| Role | Does |
| --- | --- |
| `planner` | Designs the app's layout and regions; blocks first paint. |
| `fill` | Writes the regions' content. |
| `edit` | Applies an edit request to one region, the stylesheet, or the page frame. |
| `router` | Decides which of those an edit request is about. |

Each role reads `LLM_<ROLE>_PROVIDER`, `LLM_<ROLE>_MODEL` and `LLM_<ROLE>_MAX_TOKENS`, falling back to
`LLM_PROVIDER`, `LLM_MODEL` and `LLM_MAX_TOKENS`. Two providers are supported:

- `openai`: any OpenAI-compatible chat-completions endpoint. Set `OPENAI_API_KEY`, and
  `OPENAI_BASE_URL` for a non-OpenAI endpoint.
- `anthropic`: the native Anthropic Messages API. Set `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL`
  only for a server that speaks the Anthropic wire format.

Base URLs are the bare API prefix (e.g. `https://host/v1`); each SDK appends its own endpoint path.

Fill runs in one of two modes, chosen by `LLM_FILL_MODE`:

- `sequential` (default): one call writes every region, with budget `LLM_FILL_MAX_TOKENS`.
- `parallel`: one call per region, with budget `LLM_FILL_SLOT_MAX_TOKENS`, at most
  `LLM_FILL_CONCURRENCY` at a time.

Reasoning models spend part of `max_tokens` on hidden reasoning and return empty output when the
budget is too low. Every call logs its real token usage to the studio log, so check that when tuning
budgets. Known model-specific findings are in [`.docs/open-problems.md`](.docs/open-problems.md).

Users can also supply their own provider credentials on `/settings`. They are encrypted at rest with
`CREDENTIAL_KEY`. A user-supplied base URL must be https and resolve to a public address (a user key with no base
URL goes to the provider's public API); `.env`'s own `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` apply to the platform keys only and are
not restricted. For a local fake provider or model server, set
`ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS=1` on a development machine only (the studio refuses to boot with it under
`NODE_ENV=production` or when `STUDIO_PUBLIC_URL` is not a loopback address).

## Running in production

Production runs compiled JavaScript only. Both builds (`tsc` for the servers and migrations, esbuild for the studio's
browser bundle) run once, before dev dependencies are removed, and `tsx` and `typescript` are not needed afterwards:

```sh
npm ci
npm run build:prod                        # tsc -> dist/ in each workspace, plus the minified studio bundle (no source maps)
npm prune --omit=dev                      # drops tsx, typescript, esbuild and the test dependencies
NODE_ENV=production npm run migrate:prod  # runs packages/store/dist/migrate-cli.js; DATABASE_URL in the environment or .env
```

The studio and the sandbox are separate processes. Run each under a process manager of your choice, from the repository
root, with its configuration (see `.env.example`) in the environment and `NODE_ENV=production`:

```sh
node --conditions=production apps/studio/dist/index.js
node --conditions=production apps/sandbox/dist/index.js
```

The `production` condition is what makes the workspace packages load their compiled `dist/` instead of `src/`; without
it the start fails at once. `npm run start:studio` and `npm run start:sandbox` run the same thing for a manual start, but
a process manager must not supervise them: npm does not forward SIGTERM to the server it spawns, so stopping the npm
process leaves `node` serving and holding the port. Neither form watches for changes. The `VAR=value command` lines in this section are POSIX
shell; on Windows set the variables in the environment instead.

- Create the sandbox's restricted database role (the "Without Docker" step in Setup) and set `SANDBOX_DATABASE_URL`;
  without it the sandbox falls back to the privileged `DATABASE_URL`.
- The bind addresses are hard-coded for now: the studio listens on `localhost` and the sandbox on `127.0.0.1`. Point
  `STUDIO_INTERNAL_URL` at the address the studio actually listens on (on hosts where `localhost` resolves to `::1`
  first, `http://[::1]:<port>`).
- Do not set `ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS` in production; the studio refuses to boot with it under
  `NODE_ENV=production`.

Database provisioning, TLS, reverse proxying and graceful shutdown are not covered here.

## Tests

```sh
npm run typecheck      # whole workspace, including tests
npm test               # backend suite, then frontend suite
npm run test:backend
npm run test:frontend  # Playwright (Chromium)
```

The frontend suite uses the same ports as `npm run dev`, so stop the dev servers first. Harness
details, environment precedence and port ownership are in [`tests/README.md`](tests/README.md); the
case lists are in [`.docs/tests-backend.md`](.docs/tests-backend.md) and
[`.docs/tests-frontend.md`](.docs/tests-frontend.md).

`npm run test:quality --workspace @any-app/tests` runs a generated-app quality sweep against real
providers. It costs real money, refuses to start without `--yes` (or `ANYAPP_QUALITY_RUN=1`), and is
not part of `npm test`; see [`tests/quality/README.md`](tests/quality/README.md).
