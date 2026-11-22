import { describe, it, expect } from "vitest";
import { D1CatalogRepo } from "../../src/catalog/d1-catalog-repo";

/**
 * A minimal D1Database stub that records the SQL + bound params of each
 * statement and returns canned rows. This locks down the riskiest part of the
 * better-sqlite3 → D1 port: the hand-translation of `@named` params into
 * ordered `?` positional binds. Full end-to-end SQL execution is covered by
 * `wrangler dev` against a real local D1 (migration stage 5).
 */
interface Recorded {
  sql: string;
  binds: unknown[];
}

function makeStubDb(rows: Record<string, unknown>[]) {
  const calls: Recorded[] = [];
  const db = {
    prepare(sql: string) {
      const rec: Recorded = { sql, binds: [] };
      calls.push(rec);
      const stmt = {
        bind(...args: unknown[]) {
          rec.binds = args;
          return stmt;
        },
        async first<T>() {
          return (rows[0] as T) ?? null;
        },
        async all<T>() {
          return { results: rows as T[], success: true, meta: {} };
        },
        async run() {
          return { success: true, meta: {} };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

const brandRow = {
  id: "the-news-lens",
  display_name: "The News Lens 關鍵評論網",
  aliases: JSON.stringify(["TNL", "關鍵評論網"]),
  brand_group: "TNL Mediagene",
  importance: "primary",
  drive_folder_id: "folder-tnl",
  status: "active",
};

const assetRow = {
  id: "svg-blue",
  brand_id: "the-news-lens",
  asset_type: "logo",
  variant: "logo",
  language: null,
  format: "svg",
  color: "blue",
  background: "transparent",
  layout: "horizontal",
  usage: JSON.stringify(["general"]),
  source_drive_file_id: "f1",
  source_path: "TNL/SVG/logo-blue.svg",
  source_modified_time: null,
  intrinsic_width: 300,
  intrinsic_height: 100,
  can_resize: 1,
  status: "active",
  confidence: 0.9,
  inferred_from: JSON.stringify(["folder_name"]),
  review_status: "accepted",
  review_reason: null,
  scanner_run_id: null,
};

describe("D1CatalogRepo", () => {
  it("getBrandById binds the id and maps JSON aliases", async () => {
    const { db, calls } = makeStubDb([brandRow]);
    const repo = new D1CatalogRepo(db);
    const brand = await repo.getBrandById("the-news-lens");
    expect(calls[0].sql).toContain("FROM brands WHERE id = ?");
    expect(calls[0].binds).toEqual(["the-news-lens"]);
    expect(brand?.aliases).toEqual(["TNL", "關鍵評論網"]);
  });

  it("getActiveAssets filters active+accepted and coerces can_resize", async () => {
    const { db, calls } = makeStubDb([assetRow]);
    const repo = new D1CatalogRepo(db);
    const assets = await repo.getActiveAssets("the-news-lens");
    expect(calls[0].sql).toContain("status = 'active'");
    expect(calls[0].sql).toContain("review_status = 'accepted'");
    expect(calls[0].binds).toEqual(["the-news-lens"]);
    expect(assets[0].can_resize).toBe(true);
    expect(assets[0].usage).toEqual(["general"]);
  });

  it("findAssets builds conditions and binds in placeholder order", async () => {
    const { db, calls } = makeStubDb([assetRow]);
    const repo = new D1CatalogRepo(db);
    await repo.findAssets({ brand_id: "the-news-lens", format: "svg", color: "blue" });
    // The '?' count in the SQL must equal the number of binds, in order.
    const questionMarks = (calls[0].sql.match(/\?/g) ?? []).length;
    expect(questionMarks).toBe(3);
    expect(calls[0].binds).toEqual(["the-news-lens", "svg", "blue"]);
  });

  it("findAssets binds every optional field in the documented order", async () => {
    const { db, calls } = makeStubDb([]);
    const repo = new D1CatalogRepo(db);
    await repo.findAssets({
      brand_id: "b", format: "png", color: "black", language: "zh",
      asset_type: "logo", layout: "vertical", variant: "special",
    });
    expect(calls[0].binds).toEqual(["b", "png", "black", "zh", "logo", "vertical", "special"]);
  });

  it("recordDelivery binds all ten columns positionally", async () => {
    const { db, calls } = makeStubDb([]);
    const repo = new D1CatalogRepo(db);
    await repo.recordDelivery({
      slack_user_id: "U1", brand_id: "the-news-lens", asset_id: "svg-blue",
      output_format: "png", width: 500, height: 500, background: "white",
      padding_ratio: 0.2, purpose: "簡報", purpose_url: null,
    });
    expect((calls[0].sql.match(/\?/g) ?? []).length).toBe(10);
    expect(calls[0].binds).toEqual([
      "U1", "the-news-lens", "svg-blue", "png", 500, 500, "white", 0.2, "簡報", null,
    ]);
  });
});
