import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";
import { AssetResolver } from "../../src/bot/asset-resolver";
import { CatalogRepo, BrandRecord, AssetRecord, AssetQuery } from "../../src/catalog/catalog-repo";
import { CatalogReader } from "../../src/catalog/d1-catalog-repo";
import { ConversationState } from "../../src/bot/conversation";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(join(__dirname, "../../src/db/schema.sql"), "utf-8");
  db.exec(schema);
  return db;
}

/**
 * Adapts the synchronous better-sqlite3 CatalogRepo to the async CatalogReader
 * the resolver now depends on — lets these tests keep exercising real SQL
 * queries (rather than a hand-rolled fake) against the async surface.
 */
function asReader(repo: CatalogRepo): CatalogReader {
  return {
    getBrandById: async (id) => repo.getBrandById(id),
    getAllBrands: async () => repo.getAllBrands(),
    getActiveAssets: async (brandId) => repo.getActiveAssets(brandId),
    findAssets: async (query: AssetQuery) => repo.findAssets(query),
    recordDelivery: async (row) => repo.recordDelivery(row),
  };
}

describe("AssetResolver", () => {
  let db: Database.Database;
  let repo: CatalogRepo;
  let resolver: AssetResolver;

  const brand: BrandRecord = {
    id: "the-news-lens",
    display_name: "The News Lens 關鍵評論網",
    aliases: ["TNL"],
    brand_group: null,
    importance: "primary",
    drive_folder_id: null,
    status: "active",
  };

  const svgAsset: AssetRecord = {
    id: "svg-blue",
    brand_id: "the-news-lens",
    asset_type: "logo",
    variant: "logo",
    language: null,
    format: "svg",
    color: "blue",
    background: "transparent",
    layout: "horizontal",
    usage: ["general"],
    source_drive_file_id: "f1",
    source_path: "TNL/SVG/logo-blue.svg",
    intrinsic_width: 300,
    intrinsic_height: 100,
    can_resize: true,
    status: "active",
    confidence: 0.9,
    inferred_from: [],
    review_status: "accepted",
    review_reason: null,
    scanner_run_id: null,
  };

  const pngAsset: AssetRecord = {
    id: "png-blue",
    brand_id: "the-news-lens",
    asset_type: "logo",
    variant: "logo",
    language: null,
    format: "png",
    color: "blue",
    background: "transparent",
    layout: "horizontal",
    usage: ["general"],
    source_drive_file_id: "f2",
    source_path: "TNL/PNG/tnl-primary.png",
    intrinsic_width: 500,
    intrinsic_height: 167,
    can_resize: false,
    status: "active",
    confidence: 0.9,
    inferred_from: [],
    review_status: "accepted",
    review_reason: null,
    scanner_run_id: null,
  };

  beforeEach(() => {
    db = createTestDb();
    repo = new CatalogRepo(db);
    resolver = new AssetResolver(asReader(repo));
    repo.upsertBrand(brand);
    repo.upsertAsset(svgAsset);
    repo.upsertAsset(pngAsset);
  });

  it("resolves asset matching brand, format, and color", async () => {
    const state: ConversationState = {
      userId: "u1",
      channelId: "c1",
      parsed: { brand: "TNL", format: "svg", color: "blue", language: null, asset_type: null, width: null, height: null, raw_text: "" },
      resolvedBrandId: "the-news-lens",
      resolvedAssetId: null,
      step: "done",
      startedAt: "",
    };
    const result = await resolver.resolve(state);
    expect(result?.asset.id).toBe("svg-blue");
    expect(result?.needsCustomSize).toBe(false);
  });

  it("prefers SVG source for custom-size rendering", async () => {
    const state: ConversationState = {
      userId: "u1",
      channelId: "c1",
      parsed: { brand: "TNL", format: null, color: "blue", language: null, asset_type: null, width: 500, height: 500, raw_text: "" },
      resolvedBrandId: "the-news-lens",
      resolvedAssetId: null,
      step: "done",
      startedAt: "",
    };
    const result = await resolver.resolve(state);
    expect(result?.asset.format).toBe("svg");
    expect(result?.needsCustomSize).toBe(true);
    expect(result?.requestedWidth).toBe(500);
  });

  it("returns null when no assets match", async () => {
    const state: ConversationState = {
      userId: "u1",
      channelId: "c1",
      parsed: { brand: "TNL", format: "svg", color: "red", language: null, asset_type: null, width: null, height: null, raw_text: "" },
      resolvedBrandId: "the-news-lens",
      resolvedAssetId: null,
      step: "done",
      startedAt: "",
    };
    const result = await resolver.resolve(state);
    expect(result).toBeNull();
  });

  it("returns null without resolved brand", async () => {
    const state: ConversationState = {
      userId: "u1",
      channelId: "c1",
      parsed: { brand: "TNL", format: "svg", color: "blue", language: null, asset_type: null, width: null, height: null, raw_text: "" },
      resolvedBrandId: null,
      resolvedAssetId: null,
      step: "brand_select",
      startedAt: "",
    };
    const result = await resolver.resolve(state);
    expect(result).toBeNull();
  });

  it("carries the chosen background into ResolvedAsset", async () => {
    const state: ConversationState = {
      userId: "u1",
      channelId: "c1",
      parsed: { brand: "TNL", format: "png", color: "blue", language: null, asset_type: null, width: null, height: null, background: "white", raw_text: "" },
      resolvedBrandId: "the-news-lens",
      resolvedAssetId: null,
      step: "done",
      startedAt: "",
    };
    const result = await resolver.resolve(state);
    expect(result?.background).toBe("white");
  });

  it("renders PNG output from the SVG source even at original size", async () => {
    // Both svg-blue and png-blue exist; a PNG request must still come from SVG.
    const state = {
      userId: "u1", channelId: "c1",
      parsed: { brand: "TNL", format: "png", color: "blue", language: null, asset_type: null, layout: null, width: null, height: null, background: null, paddingRatio: null, raw_text: "" },
      resolvedBrandId: "the-news-lens", resolvedAssetId: null, step: "done", startedAt: "",
    } as unknown as ConversationState;
    const result = await resolver.resolve(state);
    // PNG output at original size → render the SVG to PNG at its natural size
    // (never hand over the SVG file). Size is derived from the file at render
    // time, so it's a natural-png render, not a custom-size one.
    expect(result?.asset.format).toBe("svg");
    expect(result?.renderNaturalPng).toBe(true);
    expect(result?.needsCustomSize).toBe(false);
  });

  it("falls back to the stored PNG when no SVG exists for the variant", async () => {
    // A green PNG with no SVG counterpart.
    repo.upsertAsset({ ...pngAsset, id: "png-green", color: "green", source_drive_file_id: "fg" });
    const base = {
      userId: "u1", channelId: "c1", resolvedBrandId: "the-news-lens",
      resolvedAssetId: null, step: "done", startedAt: "",
    };

    // Original size → direct download the PNG (no render).
    const original = await resolver.resolve({
      ...base,
      parsed: { brand: "TNL", format: "png", color: "green", language: null, asset_type: null, layout: null, width: null, height: null, background: null, paddingRatio: null, raw_text: "" },
    } as unknown as ConversationState);
    expect(original?.asset.id).toBe("png-green");
    expect(original?.needsCustomSize).toBe(false);

    // Custom size → render from the PNG fallback.
    const custom = await resolver.resolve({
      ...base,
      parsed: { brand: "TNL", format: "png", color: "green", language: null, asset_type: null, layout: null, width: 500, height: 500, background: null, paddingRatio: null, raw_text: "" },
    } as unknown as ConversationState);
    expect(custom?.asset.format).toBe("png");
    expect(custom?.needsCustomSize).toBe(true);
  });

  it("returns .ai asset when custom size requested but only .ai available", async () => {
    // Add an .ai-only asset
    const aiAsset: AssetRecord = {
      id: "ai-blue",
      brand_id: "the-news-lens",
      asset_type: "logo",
      variant: "logo",
      language: null,
      format: "ai",
      color: "blue",
      background: "transparent",
      layout: "horizontal",
      usage: ["general"],
      source_drive_file_id: "f3",
      source_path: "TNL/AI/logo-blue.ai",
      intrinsic_width: null,
      intrinsic_height: null,
      can_resize: false,
      status: "active",
      confidence: 0.9,
      inferred_from: [],
      review_status: "accepted",
      review_reason: null,
      scanner_run_id: null,
    };
    repo.upsertAsset(aiAsset);

    // Request custom size with only .ai available
    const state: ConversationState = {
      userId: "u1",
      channelId: "c1",
      parsed: { brand: "TNL", format: "ai", color: "blue", language: null, asset_type: null, width: 800, height: 600, raw_text: "" },
      resolvedBrandId: "the-news-lens",
      resolvedAssetId: null,
      step: "done",
      startedAt: "",
    };
    const result = await resolver.resolve(state);
    expect(result).not.toBeNull();
    expect(result?.asset.id).toBe("ai-blue");
    expect(result?.asset.format).toBe("ai");
    // .ai cannot be resized, so delivery should treat it as direct download
    expect(result?.needsCustomSize).toBe(false);
  });
});
