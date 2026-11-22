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
- **Scan-owned tables are fully replaced** (`DELETE` then reload):
  `scanner_runs`, `brands`, `assets`, `manual_overrides`. Re-running is
  idempotent — the remote ends up exactly matching the local scan.
- **Runtime-owned tables are never touched:** `deliveries` (the append-only
  audit log) and `generated_outputs` (render cache). A catalog sync must not
  wipe audit history.
- One transaction, `defer_foreign_keys`, delete child→parent / insert
  parent→child, so foreign keys never dangle mid-sync.

`DATABASE_PATH` (default `./data/catalog.db`) selects the source DB;
`SYNC_OUT_FILE` overrides where the generated `.sql` is written (default under
`$KIROCREW_SCRATCH`/`$TMPDIR`).
