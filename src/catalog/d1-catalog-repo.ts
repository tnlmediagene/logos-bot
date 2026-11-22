/**
 * D1-backed, async catalog reader for the Cloudflare Workers bot path.
 *
 * The existing `CatalogRepo` (better-sqlite3, synchronous) stays as-is for the
 * offline scan pipeline, which keeps running on Node (plan §6). The Worker only
 * ever *reads* the catalog and appends delivery audit rows, so this class
 * implements just that surface — async, against `env.DB` — and shares the
 * record types + row mappers with the sync repo so the two never drift.
 *
 * D1 vs better-sqlite3 differences handled here:
 *   - `@named` params → `?` positional binds (D1 has no named params).
 *   - `.get()` → `.first()`; `.all()` → `.all()` returning `{ results }`.
 *   - every method is `async` (D1 is Promise-based).
 */
import type {
  AssetQuery,
  AssetRecord,
  BrandRecord,
  DeliveryRecord,
} from "./catalog-repo";
import type { CatalogReader } from "./catalog-reader";
import { toAssetRecord, toBrandRecord } from "./row-mappers";

export type { CatalogReader } from "./catalog-reader";

export class D1CatalogRepo implements CatalogReader {
  constructor(private db: D1Database) {}

  async getBrandById(brandId: string): Promise<BrandRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM brands WHERE id = ?`)
      .bind(brandId)
      .first<Record<string, unknown>>();
    return row ? toBrandRecord(row) : null;
  }

  async getAllBrands(): Promise<BrandRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM brands WHERE status = 'active'`)
      .all<Record<string, unknown>>();
    return results.map(toBrandRecord);
  }

  async getActiveAssets(brandId: string): Promise<AssetRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM assets WHERE brand_id = ? AND status = 'active' AND review_status = 'accepted'`
      )
      .bind(brandId)
      .all<Record<string, unknown>>();
    return results.map(toAssetRecord);
  }

  async findAssets(query: AssetQuery): Promise<AssetRecord[]> {
    const conditions: string[] = ["status = 'active'", "review_status = 'accepted'"];
    const binds: string[] = [];

    // Order of pushes must match the order of `?` placeholders below.
    if (query.brand_id) { conditions.push("brand_id = ?"); binds.push(query.brand_id); }
    if (query.format) { conditions.push("format = ?"); binds.push(query.format); }
    if (query.color) { conditions.push("color = ?"); binds.push(query.color); }
    if (query.language) { conditions.push("language = ?"); binds.push(query.language); }
    if (query.asset_type) { conditions.push("asset_type = ?"); binds.push(query.asset_type); }
    if (query.layout) { conditions.push("layout = ?"); binds.push(query.layout); }
    if (query.variant) { conditions.push("variant = ?"); binds.push(query.variant); }

    const { results } = await this.db
      .prepare(`SELECT * FROM assets WHERE ${conditions.join(" AND ")}`)
      .bind(...binds)
      .all<Record<string, unknown>>();
    return results.map(toAssetRecord);
  }

  async recordDelivery(row: DeliveryRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO deliveries
           (slack_user_id, brand_id, asset_id, output_format, width, height, background, padding_ratio, purpose, purpose_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.slack_user_id,
        row.brand_id,
        row.asset_id,
        row.output_format,
        row.width,
        row.height,
        row.background,
        row.padding_ratio,
        row.purpose,
        row.purpose_url
      )
      .run();
  }
}
