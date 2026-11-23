import Database from "better-sqlite3";

/**
 * Tables the OFFLINE SCAN owns. The live Worker never writes these, so the
 * sync may freely upsert/remove rows in them.
 */
export const SCAN_OWNED_TABLES = [
  "scanner_runs",
  "brands",
  "assets",
  "manual_overrides",
] as const;

/**
 * Tables the LIVE BOT owns at runtime. The sync must never DISCARD data in
 * them:
 *   - `deliveries`      is the audit log (source of truth, append-only) — the
 *     sync never touches this table at all.
 *   - `generated_outputs` is the render cache, with a real foreign key into
 *     `assets(id)`. The sync only ever removes a row here when the asset it
 *     was rendered from no longer exists in the new scan — see
 *     `buildSyncSql`'s assets handling below.
 */
export const RUNTIME_OWNED_TABLES = ["deliveries", "generated_outputs"] as const;

/** Scan-owned tables that `generated_outputs`/`assets` can have a live FK into. */
const FK_PARENT_TABLES = ["scanner_runs", "brands", "assets"] as const;

type Row = Record<string, unknown>;

/** SQLite literal for a single value, matching `sqlite3 .mode insert` output. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const hex = Buffer.from(value as Uint8Array).toString("hex");
    return `X'${hex}'`;
  }
  // Text: single-quote escape, exactly like SQLite's own quoting.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insertStatement(table: string, columns: string[], row: Row): string {
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const vals = columns.map((c) => sqlLiteral(row[c])).join(", ");
  return `INSERT INTO "${table}" (${cols}) VALUES (${vals});`;
}

/**
 * Upsert: insert the row, or overwrite every column in place if its id
 * already exists. Never deletes the row first — the row's identity (and
 * anything with a foreign key pointing at it) survives the statement.
 */
function upsertStatement(table: string, columns: string[], row: Row): string {
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const vals = columns.map((c) => sqlLiteral(row[c])).join(", ");
  const updates = columns
    .filter((c) => c !== "id")
    .map((c) => `"${c}" = excluded."${c}"`)
    .join(", ");
  return (
    `INSERT INTO "${table}" (${cols}) VALUES (${vals}) ` +
    `ON CONFLICT("id") DO UPDATE SET ${updates};`
  );
}

/** `DELETE FROM "table" WHERE "idCol" NOT IN (...)`, or delete everything if `keepIds` is empty. */
function deleteNotIn(table: string, idCol: string, keepIds: Set<string>): string {
  if (keepIds.size === 0) return `DELETE FROM "${table}";`;
  const list = [...keepIds].map((id) => sqlLiteral(id)).join(", ");
  return `DELETE FROM "${table}" WHERE "${idCol}" NOT IN (${list});`;
}

function columnsOf(db: Database.Database, table: string): string[] {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name
  );
  if (columns.length === 0) {
    throw new Error(`Table "${table}" not found in local catalog — is the scan db migrated?`);
  }
  return columns;
}

/**
 * Build a D1-safe, DATA-ONLY sync script from a local SQLite catalog.
 *
 * The remote schema is owned by `wrangler d1 migrations` — this script emits
 * NO DDL, and has no explicit `BEGIN`/`COMMIT`: `wrangler d1 execute`'s remote
 * HTTP exec endpoint rejects explicit `BEGIN TRANSACTION`/`SAVEPOINT`
 * statements outright ("use state.storage.transaction() instead"), and
 * without one, each statement in the file runs with its own implicit
 * transaction — `PRAGMA defer_foreign_keys` has no multi-statement scope to
 * defer *within*.
 *
 * That constraint rules out the original "DELETE every scan-owned table, then
 * reload" design for `scanner_runs`/`brands`/`assets`: `generated_outputs`
 * (a RUNTIME-owned table this sync must never touch) has a real foreign key
 * into `assets(id)`, so `DELETE FROM assets` fails immediately the moment any
 * cached render exists — there's no later statement in the same batch where a
 * deferred check could re-validate it. (`assets.brand_id` and
 * `assets.scanner_run_id` have the same problem one level up, against
 * `brands`/`scanner_runs`.)
 *
 * So `scanner_runs`, `brands`, and `assets` are each **upserted** — existing
 * ids are updated in place, never deleted and reinserted — and a row is only
 * ever `DELETE`d when its id is absent from the new scan entirely (a brand or
 * asset that's genuinely gone). Deleting `assets` that are gone first purges
 * their now-orphaned `generated_outputs` rows (a stale cache entry pointing
 * at a deleted asset is meaningless — keeping it would only leave a dangling
 * foreign key the next sync couldn't apply at all), and nothing else in
 * `generated_outputs` is ever touched. `manual_overrides` has no inbound
 * foreign key from anywhere, so it keeps the simpler reset-and-reload.
 */
export function buildSyncSql(db: Database.Database): string {
  const lines: string[] = [];
  lines.push("-- logos-bot catalog sync — generated by src/sync/dump-catalog.ts");
  lines.push("-- DATA ONLY. Remote schema is managed by wrangler d1 migrations.");
  lines.push("-- Idempotent: upserts scanner_runs/brands/assets by id, resets manual_overrides.");
  lines.push('PRAGMA defer_foreign_keys = TRUE;');

  for (const table of FK_PARENT_TABLES) {
    const columns = columnsOf(db, table);
    const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Row[];
    const keepIds = new Set(rows.map((r) => String(r.id)));

    if (table === "assets") {
      // An asset about to be removed may still have a generated_outputs row
      // pointing at it — purge those first, or the DELETE below violates the
      // foreign key with no later statement to reconcile it.
      lines.push(`-- generated_outputs: drop rows for assets no longer in the scan`);
      lines.push(deleteNotIn("generated_outputs", "source_asset_id", keepIds));
    }

    lines.push(`-- ${table}: remove rows no longer in the scan`);
    lines.push(deleteNotIn(table, "id", keepIds));

    if (rows.length > 0) {
      lines.push(`-- ${table}: upsert ${rows.length} row(s)`);
      for (const row of rows) lines.push(upsertStatement(table, columns, row));
    }
  }

  // manual_overrides has no foreign key pointing at it from any table — a
  // plain reset-and-reload is safe exactly as it always was.
  const moColumns = columnsOf(db, "manual_overrides");
  const moRows = db.prepare(`SELECT * FROM "manual_overrides"`).all() as Row[];
  lines.push(`DELETE FROM "manual_overrides";`);
  if (moRows.length > 0) {
    lines.push(`-- manual_overrides: ${moRows.length} row(s)`);
    for (const row of moRows) lines.push(insertStatement("manual_overrides", moColumns, row));
  }

  lines.push("");
  return lines.join("\n");
}
