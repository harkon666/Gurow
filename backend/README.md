# Gurow backend

Bun + Hono learning-domain service backed by PostgreSQL through Drizzle ([ADR 0021](../docs/adr/0021-persist-the-backend-with-drizzle-over-bun-sql.md)).

## Setup

```sh
docker compose up -d --wait   # from the repo root: PostgreSQL 18 on 127.0.0.1:5433
cp .env.example .env          # DATABASE_URL and TEST_DATABASE_URL
bun install
bun run db:migrate            # apply drizzle/ migrations to DATABASE_URL
```

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Serve on http://localhost:3000 |
| `bun test` | Request-level integration tests; creates, migrates and empties `gurow_test` |
| `bun run typecheck` | TypeScript check |
| `bun run db:generate` | Generate a SQL migration from `src/db/schema.ts` changes; review and commit it |
| `bun run db:migrate` | Apply committed migrations |

## Identity

Learning routes act for the Account returned by the injected `IdentityResolver`. Production has no sign-in yet, so `src/index.ts` uses `noTrustedIdentity` and those routes answer 401. Integration tests use `fixtureIdentity`, which maps the `x-gurow-fixture-identity` header to fixture Accounts; it is never wired into the production entry point.
