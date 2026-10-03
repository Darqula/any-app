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

Both apps run TypeScript directly through `tsx`; there is no build step.

## Setup

**Requirements:** Node.js 22+, PostgreSQL (e.g. `postgres:17` in Docker), and a browser that resolves
`*.localhost` to loopback (Chrome, Edge and Firefox do; for Safari or restrictive DNS, see
`SANDBOX_APP_ORIGIN_TEMPLATE` below).

1. Install dependencies:
   ```sh
   npm install
   ```
2. Create an empty database (named `anyapp` below).
3. Copy `.env.example` to `.env` and fill in at least:
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
4. Apply migrations:
   ```sh
   npm run migrate
   ```
5. Create the sandbox's restricted role, using the password from `SANDBOX_DATABASE_URL`. It may touch
   the `records` table and nothing else; never give it a broader grant such as `on all tables`:
   ```sql
   create role anyapp_sandbox login password 'choose-one';
   grant usage on schema public to anyapp_sandbox;
   grant select, insert, update, delete on records to anyapp_sandbox;
   ```
6. Start both servers and open `http://localhost:3000`:
   ```sh
   npm run dev
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
`CREDENTIAL_KEY`.

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
