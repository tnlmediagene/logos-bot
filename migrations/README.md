# D1 migrations

Applied in order by `wrangler d1 migrations apply`.

- `0001_init.sql` — full catalog schema, ported from `src/db/schema.sql`.

## Why there is no `0002` for `source_modified_time`

The Node code has a `migrate()` step in `src/db/connection.ts` that back-fills
the `assets.source_modified_time` column via `ALTER TABLE`. That exists only to
upgrade databases created **before** the column was added to `schema.sql`.

`0001_init.sql` already declares `source_modified_time`, so a fresh D1 database
has the column from the start. Reproducing the ALTER as `0002` would fail with
`duplicate column name` on a clean D1. New columns from here on get their own
numbered migration file instead.

## Commands

```sh
# One-time: create the D1 database, then paste the id into wrangler.jsonc
wrangler d1 create logos-bot-catalog

# Apply migrations (local dev DB)
wrangler d1 migrations apply logos-bot-catalog --local

# Apply migrations (remote/production)
wrangler d1 migrations apply logos-bot-catalog --remote
```

## Syncing the offline scan into D1

The scanner stays on Node (`npm run scan` → local `./data/catalog.db`,
`better-sqlite3`). To push that catalog into D1, use the sync CLI, which emits a
**data-only, idempotent** SQL file and applies it with `wrangler d1 execute`:

```sh
npm run scan            # 1. refresh local catalog.db from Drive
npm run sync:d1:local   # 2a. push into the LOCAL dev D1
npm run sync:d1:remote  # 2b. push into the REMOTE/prod D1
npm run sync:d1         # dump-only: write the SQL file, apply nothing
```

What the sync does and why it is safe:

- **Data only, no DDL.** The remote schema is owned by `d1 migrations`; the sync
  never emits `CREATE`/`ALTER`/`DROP`. Run migrations first on a fresh D1.
- **No explicit transaction.** `wrangler d1 execute`'s remote HTTP exec
  endpoint rejects explicit `BEGIN TRANSACTION`/`SAVEPOINT` statements
  outright, so every statement in the file runs with its own implicit,
  single-statement transaction — there's no multi-statement scope for
  `PRAGMA defer_foreign_keys` to defer *within*.
- **`scanner_runs`/`brands`/`assets` are upserted, never delete-then-reload.**
  Each row is inserted, or has every column overwritten in place
  (`ON CONFLICT("id") DO UPDATE`) if its id already exists — an existing row's
  identity (and anything with a foreign key pointing at it) is never
  interrupted. A row is only ever `DELETE`d when its id is absent from the
  new scan entirely. Deletes run first, in strict child→parent order
  (`generated_outputs` → `assets` → `brands` → `scanner_runs`), then upserts
  run in the opposite, parent→child order — so a parent is never removed
  while a child might still reference it, and a child's foreign keys always
  resolve to a row that already exists by the time it's written.
- **`manual_overrides` is fully replaced** (`DELETE` then reload) — nothing
  has a foreign key into it, so the simpler reset-and-reload is safe there.
- **Runtime-owned tables are never touched:** `deliveries` (the append-only
  audit log) and `generated_outputs` (render cache), except that
  `generated_outputs` rows are purged when the asset they were rendered from
  is genuinely gone from the new scan — a stale cache row pointing at a
  deleted asset would otherwise leave a dangling foreign key.
- Re-running the same sync is idempotent — the remote ends up matching the
  local scan either way.

`DATABASE_PATH` (default `./data/catalog.db`) selects the source DB;
`SYNC_OUT_FILE` overrides where the generated `.sql` is written (default under
`$KIROCREW_SCRATCH`/`$TMPDIR`).
