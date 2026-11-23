import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyncSql, SCAN_OWNED_TABLES, RUNTIME_OWNED_TABLES } from "../../src/sync/dump-catalog";

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

  it("resets every scan-owned table and inserts its rows", () => {
    const sql = buildSyncSql(db);
    for (const t of SCAN_OWNED_TABLES) {
      expect(sql).toContain(`DELETE FROM "${t}";`);
    }
    expect(sql).toContain(`INSERT INTO "brands"`);
    expect(sql).toContain(`INSERT INTO "assets"`);
    expect(sql).toContain(`INSERT INTO "scanner_runs"`);
    expect(sql).toContain(`INSERT INTO "manual_overrides"`);
  });

  it("never touches runtime-owned tables (audit log + render cache)", () => {
    const sql = buildSyncSql(db);
    for (const t of RUNTIME_OWNED_TABLES) {
      expect(sql).not.toContain(`DELETE FROM "${t}";`);
      expect(sql).not.toContain(`INSERT INTO "${t}"`);
    }
    expect(sql).not.toContain("twitter post");
    expect(sql).not.toContain("/cache/a1.png");
  });

  it("deletes child→parent and inserts parent→child (FK-safe)", () => {
    const sql = buildSyncSql(db);
    // DELETE assets must come before DELETE brands.
    expect(sql.indexOf(`DELETE FROM "assets";`)).toBeLessThan(
      sql.indexOf(`DELETE FROM "brands";`)
    );
    // INSERT brands must come before INSERT assets.
    expect(sql.indexOf(`INSERT INTO "brands"`)).toBeLessThan(
      sql.indexOf(`INSERT INTO "assets"`)
    );
  });

  it("escapes single quotes and preserves unicode / JSON strings", () => {
    db.prepare(
      "INSERT INTO brands (id, display_name, aliases) VALUES ('x', 'O''Reilly 名字', '[\"a\",\"b\"]')"
    ).run();
    const sql = buildSyncSql(db);
    expect(sql).toContain("'O''Reilly 名字'");
    expect(sql).toContain('[\"a\",\"b\"]'.replace(/"/g, '"')); // JSON kept verbatim
  });

  it("applies cleanly against a fresh migrated DB and reproduces the data", () => {
    const sql = buildSyncSql(db);
    const target = new Database(":memory:");
    target.exec(SCHEMA);
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
    const target = new Database(":memory:");
    target.exec(SCHEMA);
    target.exec(sql);
    target.exec(sql);
    expect((target.prepare("SELECT COUNT(*) c FROM brands").get() as { c: number }).c).toBe(1);
    expect((target.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c).toBe(1);
    target.close();
  });
});
