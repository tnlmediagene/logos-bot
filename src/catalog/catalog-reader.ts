import type {
  AssetQuery,
  AssetRecord,
  BrandRecord,
  DeliveryRecord,
} from "./catalog-repo";

/**
 * The catalog surface the bot (Worker) depends on. Deliberately read-only plus
 * the single audit append — the scan-only write methods live on the sync
 * `CatalogRepo` and are never reachable from a Worker request.
 *
 * Kept in its own platform-neutral file (no D1 types) so Node-compiled code
 * such as `AssetResolver` can import it.
 */
export interface CatalogReader {
  getBrandById(brandId: string): Promise<BrandRecord | null>;
  getAllBrands(): Promise<BrandRecord[]>;
  getActiveAssets(brandId: string): Promise<AssetRecord[]>;
  findAssets(query: AssetQuery): Promise<AssetRecord[]>;
  recordDelivery(row: DeliveryRecord): Promise<void>;
}
