/**
 * Row → record mappers shared by the sync `CatalogRepo` (better-sqlite3, offline
 * scan) and the async `D1CatalogRepo` (Workers bot). Kept in one place so the
 * JSON-column parsing and integer→boolean coercion can never drift between the
 * two backends.
 */
import type { AssetRecord, BrandRecord } from "./catalog-repo";

export function toBrandRecord(row: Record<string, unknown>): BrandRecord {
  return {
    ...(row as unknown as BrandRecord),
    aliases: JSON.parse((row.aliases as string) ?? "[]"),
  };
}

export function toAssetRecord(row: Record<string, unknown>): AssetRecord {
  return {
    ...(row as unknown as AssetRecord),
    usage: JSON.parse((row.usage as string) ?? "[]"),
    inferred_from: JSON.parse((row.inferred_from as string) ?? "[]"),
    can_resize: row.can_resize === 1,
  };
}
