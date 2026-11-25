import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyncSql, RUNTIME_OWNED_TABLES } from "../../src/sync/dump-catalog";

const SCHEMA = readFileSync(join(__dirname, "../../migrations/0001_init.sql"), "utf-8");

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO scanner_runs (id, status, files_found) VALUES (1, 'completed', 2)").run();
  db.prepare(
    "INSERT INTO brands (id, display_name, aliases) VALUES ('tnl', 'TNL', '[\"關鍵評論網\"]')"
  ).run();
  db.prepare(
    `INSERT INTO assets (id, brand_id, asset_type, variant, format, usage, source_drive_file_id, source_path, inferred_from, scanner_run_id)
     VALUES ('a1', 'tnl', 'logo', 'primary', 'svg', '["general"]', 'file1', '/p/a1.svg', '[]', 1)`
  ).run();
  db.prepare(
    "INSERT INTO manual_overrides (asset_id, field_name, override_value) VALUES ('a1', 'color', 'blue')"
  ).run();
  // Runtime-owned rows that MUST survive a sync.
  db.prepare(
    "INSERT INTO deliveries (slack_user_id, purpose) VALUES ('U1', 'twitter post')"
  ).run();
  db.prepare(
    `INSERT INTO generated_outputs (source_asset_id, requested_width, requested_height, file_path)
     VALUES ('a1', 100, 50, '/cache/a1.png')`
  ).run();
  return db;
}

/** A target DB already migrated, with no data — the usual real-world starting point. */
function freshTarget(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

describe("buildSyncSql", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = seedDb();
  });
  afterEach(() => db.close());

  it("emits data-only SQL — no CREATE/ALTER/DROP DDL", () => {
    const sql = buildSyncSql(db);
    expect(sql).not.toMatch(/CREATE\s+TABLE/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    // Remote D1's exec endpoint rejects explicit BEGIN/SAVEPOINT — the whole
    // file is sent as one batch and applied atomically by D1 itself.
    expect(sql).not.toMatch(/BEGIN\s+TRANSACTION/i);
    expect(sql).not.toMatch(/\bCOMMIT\b/i);
    expect(sql).not.toMatch(/SAVEPOINT/i);
  });

  it("upserts scanner_runs/brands/assets by id instead of delete-then-reinsert", () => {
    const sql = buildSyncSql(db);
    for (const t of ["scanner_runs", "brands", "assets"]) {
      expect(sql).toContain(`INSERT INTO "${t}"`);
      expect(sql).toContain(`ON CONFLICT("id") DO UPDATE SET`);
      // Never a blanket delete of these — see the FK-safety test below for why.
      expect(sql).not.toContain(`DELETE FROM "${t}";`);
    }
  });

  it("resets and reloads manual_overrides (no foreign key points at it)", () => {
    const sql = buildSyncSql(db);
    expect(sql).toContain(`DELETE FROM "manual_overrides";`);
    const insertLine = sql.split("\n").find((l) => l.startsWith(`INSERT INTO "manual_overrides"`));
    expect(insertLine).toBeDefined();
    // Plain insert, not an upsert — manual_overrides is fully reset first.
    expect(insertLine).not.toContain("ON CONFLICT");
  });

  it("never touches the audit log, and only ever removes generated_outputs rows whose asset is gone", () => {
    const sql = buildSyncSql(db);
    expect(sql).not.toContain(`DELETE FROM "deliveries"`);
    expect(sql).not.toContain(`INSERT INTO "deliveries"`);
    expect(sql).not.toContain("twitter post");
    // generated_outputs IS referenced (to purge orphans), but never wiped
    // outright, and the surviving asset's cache row is never touched.
    expect(sql).not.toContain(`DELETE FROM "generated_outputs";`);
    expect(sql).not.toContain(`INSERT INTO "generated_outputs"`);
    expect(sql).not.toContain("/cache/a1.png");
  });

  it("purges generated_outputs for a removed asset before deleting the asset itself", () => {
    const sql = buildSyncSql(db);
    const purgeIdx = sql.indexOf(`DELETE FROM "generated_outputs" WHERE "source_asset_id" NOT IN`);
    const assetsDeleteIdx = sql.indexOf(`DELETE FROM "assets" WHERE "id" NOT IN`);
    expect(purgeIdx).toBeGreaterThanOrEqual(0);
    expect(assetsDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(purgeIdx).toBeLessThan(assetsDeleteIdx);
  });

  it("escapes single quotes and preserves unicode / JSON strings", () => {
    db.prepare(
      "INSERT INTO brands (id, display_name, aliases) VALUES ('x', 'O''Reilly 名字', '[\"a\",\"b\"]')"
    ).run();
    const sql = buildSyncSql(db);
    expect(sql).toContain("'O''Reilly 名字'");
    expect(sql).toContain('["a","b"]'); // JSON kept verbatim
  });

  it("applies cleanly against a fresh migrated DB and reproduces the data", () => {
    const sql = buildSyncSql(db);
    const target = freshTarget();
    // Pre-existing audit row that must survive (sync doesn't touch deliveries).
    target.prepare("INSERT INTO deliveries (slack_user_id, purpose) VALUES ('keep', 'old')").run();
    target.exec(sql);
    expect((target.prepare("SELECT COUNT(*) c FROM brands").get() as { c: number }).c).toBe(1);
    expect((target.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c).toBe(1);
    expect((target.prepare("SELECT display_name FROM brands WHERE id='tnl'").get() as { display_name: string }).display_name).toBe("TNL");
    // Audit log untouched.
    expect((target.prepare("SELECT COUNT(*) c FROM deliveries").get() as { c: number }).c).toBe(1);
    target.close();
  });

  it("is idempotent — applying twice yields the same row counts", () => {
    const sql = buildSyncSql(db);
    const target = freshTarget();
    target.exec(sql);
    target.exec(sql);
    expect((target.prepare("SELECT COUNT(*) c FROM brands").get() as { c: number }).c).toBe(1);
    expect((target.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c).toBe(1);
    target.close();
  });

  // Regression coverage for the bug a Copilot PR review caught (and this
  // repo's own first real `sync:d1:remote` run against production
  // reproduced): the original delete-then-reinsert design failed outright
  // the moment any `generated_outputs` row existed, because D1's remote exec
  // endpoint runs each statement without a wrapping transaction, so
  // `PRAGMA defer_foreign_keys` had nothing to defer *within*.
  describe("generated_outputs foreign key safety", () => {
    it("does not touch (or break) a cache row for an asset that still exists", () => {
      const sql = buildSyncSql(db); // db's only asset, 'a1', has a cache row.
      const target = freshTarget();
      // The SAME asset already exists in the target, with the SAME cache row
      // a real render would have produced — the exact scenario that crashed.
      target.prepare("INSERT INTO brands (id, display_name, aliases) VALUES ('tnl', 'TNL', '[]')").run();
      target
        .prepare(
          `INSERT INTO assets (id, brand_id, asset_type, variant, format, usage, source_drive_file_id, source_path, inferred_from, scanner_run_id)
           VALUES ('a1', 'tnl', 'logo', 'primary', 'svg', '["general"]', 'file1', '/p/a1.svg', '[]', NULL)`
        )
        .run();
      target
        .prepare(
          `INSERT INTO generated_outputs (source_asset_id, requested_width, requested_height, file_path)
           VALUES ('a1', 100, 50, '/cache/a1.png')`
        )
        .run();

      expect(() => target.exec(sql)).not.toThrow();

      expect((target.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c).toBe(1);
      // The cache row survived untouched — the asset was updated in place,
      // never deleted, so the foreign key was never broken.
      const cache = target.prepare("SELECT * FROM generated_outputs").get() as any;
      expect(cache.source_asset_id).toBe("a1");
      expect(cache.file_path).toBe("/cache/a1.png");
    });

    it("purges a cache row when its asset is genuinely removed from the scan", () => {
      // The new scan no longer has 'a1' at all (e.g. the file was deleted/renamed).
      db.prepare("DELETE FROM generated_outputs").run();
      db.prepare("DELETE FROM manual_overrides").run();
      db.prepare("DELETE FROM assets").run();
      db.prepare(
        `INSERT INTO assets (id, brand_id, asset_type, variant, format, usage, source_drive_file_id, source_path, inferred_from, scanner_run_id)
         VALUES ('a2', 'tnl', 'logo', 'primary', 'svg', '["general"]', 'file2', '/p/a2.svg', '[]', 1)`
      ).run();
      const sql = buildSyncSql(db);

      const target = freshTarget();
      target.prepare("INSERT INTO brands (id, display_name, aliases) VALUES ('tnl', 'TNL', '[]')").run();
      target
        .prepare(
          `INSERT INTO assets (id, brand_id, asset_type, variant, format, usage, source_drive_file_id, source_path, inferred_from, scanner_run_id)
           VALUES ('a1', 'tnl', 'logo', 'primary', 'svg', '["general"]', 'file1', '/p/a1.svg', '[]', NULL)`
        )
        .run();
      target
        .prepare(
          `INSERT INTO generated_outputs (source_asset_id, requested_width, requested_height, file_path)
           VALUES ('a1', 100, 50, '/cache/a1.png')`
        )
        .run();

      expect(() => target.exec(sql)).not.toThrow();

      // 'a1' and its orphaned cache row are both gone; 'a2' (the new asset) exists.
      expect(target.prepare("SELECT id FROM assets").all()).toEqual([{ id: "a2" }]);
      expect((target.prepare("SELECT COUNT(*) c FROM generated_outputs").get() as { c: number }).c).toBe(0);
    });

    // Regression coverage for the round-2 Copilot review finding: the
    // previous delete pass ran parent → child ("scanner_runs", then
    // "brands", then "assets"), so a brand removed from the scan was
    // DELETEd before the stale asset still pointing at it — violating
    // assets.brand_id's foreign key. Deletes must run child → parent
    // instead, so the referencing asset is already gone by the time its
    // parent brand (or scanner_run) is removed.
    it("removes a stale brand only after the stale asset referencing it is already gone", () => {
      // The new scan no longer has brand 'old' or its asset 'a1' at all.
      db.prepare("DELETE FROM generated_outputs").run();
      db.prepare("DELETE FROM manual_overrides").run();
      db.prepare("DELETE FROM assets").run();
      db.prepare("DELETE FROM brands").run();
      db.prepare("INSERT INTO brands (id, display_name, aliases) VALUES ('tnl', 'TNL', '[]')").run();
      db.prepare(
        `INSERT INTO assets (id, brand_id, asset_type, variant, format, usage, source_drive_file_id, source_path, inferred_from, scanner_run_id)
         VALUES ('a2', 'tnl', 'logo', 'primary', 'svg', '["general"]', 'file2', '/p/a2.svg', '[]', 1)`
      ).run();
      const sql = buildSyncSql(db);

      const target = freshTarget();
      target.prepare("INSERT INTO brands (id, display_name, aliases) VALUES ('old', 'Old Brand', '[]')").run();
      target
        .prepare(
          `INSERT INTO assets (id, brand_id, asset_type, variant, format, usage, source_drive_file_id, source_path, inferred_from, scanner_run_id)
           VALUES ('a1', 'old', 'logo', 'primary', 'svg', '["general"]', 'file1', '/p/a1.svg', '[]', NULL)`
        )
        .run();

      expect(() => target.exec(sql)).not.toThrow();

      // The stale brand and its stale asset are both gone; the new ones exist.
      expect(target.prepare("SELECT id FROM brands").all()).toEqual([{ id: "tnl" }]);
      expect(target.prepare("SELECT id FROM assets").all()).toEqual([{ id: "a2" }]);
    });
  });
});

describe("RUNTIME_OWNED_TABLES", () => {
  it("still names deliveries and generated_outputs as never-wiped tables", () => {
    expect(RUNTIME_OWNED_TABLES).toEqual(["deliveries", "generated_outputs"]);
  });
});
