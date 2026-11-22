import { describe, it, expect, vi } from "vitest";
import { handleMessage, MessageDeps, MessagePorts } from "../../src/bot/worker-message-handler";
import { ConversationManager } from "../../src/bot/conversation";
import { AssetResolver, ResolvedAsset } from "../../src/bot/asset-resolver";
import { AssetRecord, BrandRecord } from "../../src/catalog/catalog-repo";

function makeAsset(over: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: "a1", brand_id: "tnl", format: "svg", color: "blue", language: null,
    asset_type: "logo", layout: null, background: "transparent",
    source_path: "TNL/logo-blue.svg", source_drive_file_id: "drive-1",
    status: "active", review_status: "accepted",
    width: null, height: null, source_modified_time: null,
    ...over,
  } as AssetRecord;
}

const brand: BrandRecord = { id: "tnl", display_name: "TNL", aliases: ["TNL"], status: "active" } as BrandRecord;

/** Minimal CatalogReader fake. */
function fakeRepo(assets: AssetRecord[]) {
  return {
    getBrandById: vi.fn(async (id: string) => (id === "tnl" ? brand : null)),
    getAllBrands: vi.fn(async () => [brand]),
    getActiveAssets: vi.fn(async () => assets),
    findAssets: vi.fn(async () => assets),
    recordDelivery: vi.fn(async () => {}),
  };
}

/** Parser stub that returns a fully-resolved single-brand request. */
function fakeParser(brandId: string | null, format: string | null = null) {
  return {
    parseUserRequest: () => ({
      brand: brandId, brandCandidates: brandId ? [brandId] : [],
      format, color: null, language: null, asset_type: null,
      layout: null, background: null, width: null, height: null,
      paddingRatio: null, raw_text: "x",
    }),
  } as any;
}

function makePorts(): MessagePorts & { said: any[]; uploads: any[]; audits: any[] } {
  const said: any[] = [];
  const uploads: any[] = [];
  const audits: any[] = [];
  return {
    said, uploads, audits,
    say: async (m) => { said.push(m); },
    uploadFile: async (bytes, filename, title) => { uploads.push({ bytes, filename, title }); },
    audit: (e) => { audits.push(e); },
  };
}

/** A ConversationState mid-flow, awaiting the mandatory purpose reply. */
function seedPurposeState(brandId: string) {
  return {
    userId: "u1", channelId: "", resolvedBrandId: brandId, resolvedAssetId: null,
    awaitingCustomSize: false, awaitingPurpose: true, sizeResolved: true,
    backgroundResolved: true, purpose: null, purposeUrl: null,
    step: "confirm", startedAt: "2026-10-01T00:00:00.000Z",
    parsed: {
      brand: brandId, brandCandidates: [brandId], format: null, color: null,
      language: null, asset_type: null, layout: null, background: null,
      width: null, height: null, paddingRatio: null, raw_text: "x",
    },
  } as any;
}

function makeConversations() {
  const store = new Map<string, any>();
  return {
    get: vi.fn(async (u: string) => store.get(u)),
    set: vi.fn(async (u: string, s: any) => { store.set(u, s); }),
    delete: vi.fn(async (u: string) => { store.delete(u); }),
  };
}

/** Fake CF Images binding: records the transform opts and returns stub PNG bytes. */
function fakeImages() {
  const calls: any[] = [];
  const binding = {
    calls,
    input(_src: any) {
      return {
        transform(opts: any) {
          calls.push(opts);
          return {
            output(_o: any) {
              return Promise.resolve({
                response: () => new Response(new Uint8Array([9, 9, 9])),
                image: () => new Response(new Uint8Array([9, 9, 9])).body!,
              });
            },
          };
        },
      };
    },
  };
  return binding as any;
}

function deps(repo: any, resolver: AssetResolver, parser: any, conversations: any, images?: any): MessageDeps {
  return {
    parser,
    conversationManager: new ConversationManager(),
    conversations,
    resolver,
    repo,
    driveClient: { downloadFile: vi.fn(async () => new Uint8Array([1, 2, 3])) } as any,
    images: images ?? fakeImages(),
    maxOutputSize: 4096,
  };
}

describe("handleMessage (Worker pipeline)", () => {
  it("asks a guided question and persists state on a fresh request (no immediate delivery)", async () => {
    const asset = makeAsset({ format: "svg" });
    const repo = fakeRepo([asset]);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();

    await handleMessage("TNL logo", "u1", deps(repo, resolver, fakeParser("tnl"), conversations), ports);

    // No delivery on the first turn — a guided question is asked and state saved.
    expect(ports.uploads).toHaveLength(0);
    expect(conversations.set).toHaveBeenCalled();
    expect(ports.said).toHaveLength(1);
    expect(typeof ports.said[0].text).toBe("string");
  });

  it("direct-downloads and uploads the original file after the purpose reply", async () => {
    const asset = makeAsset({ format: "svg" });
    const repo = fakeRepo([asset]);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();
    const d = deps(repo, resolver, fakeParser("tnl", "svg"), conversations);

    // Turn 1: fresh request → purpose question.
    await handleMessage("TNL svg logo", "u1", d, ports);
    // Turn 2: the purpose reply resolves + delivers.
    await handleMessage("放在官網首頁", "u1", d, ports);

    expect(ports.uploads).toHaveLength(1);
    expect(ports.uploads[0].filename).toBe("logo-blue.svg");
    expect(Array.from(ports.uploads[0].bytes)).toEqual([1, 2, 3]);
    expect(conversations.delete).toHaveBeenCalledWith("u1");
    // Audit fires for the delivered asset (direct download → source format).
    expect(ports.audits).toHaveLength(1);
    expect(ports.audits[0]).toMatchObject({ slack_user_id: "u1", brand_id: "tnl", asset_id: "a1", output_format: "svg", assetLabel: "logo-blue.svg" });
  });

  it("renders a custom size via the Images binding and uploads the PNG", async () => {
    const asset = makeAsset({ format: "png", source_path: "TNL/logo-blue.png" });
    const repo = fakeRepo([asset]);
    // Resolver stub forcing a custom-size render from a PNG source (CF Images
    // path — no svg2png-wasm, so this runs in plain vitest).
    const resolver = {
      resolve: async (): Promise<ResolvedAsset> => ({
        asset, needsCustomSize: true, renderNaturalPng: false,
        requestedWidth: 1200, requestedHeight: 630, background: "white",
        paddingRatio: null, requestedByUserId: "u1", purpose: null, purposeUrl: null,
      }),
    } as any;
    const conversations = makeConversations();
    const ports = makePorts();
    const images = fakeImages();
    await conversations.set("u1", seedPurposeState("tnl"));

    await handleMessage("1200x630", "u1", deps(repo, resolver, fakeParser("tnl"), conversations, images), ports);

    // Rendered PNG uploaded with a .png filename, Images called at the exact canvas.
    expect(ports.uploads).toHaveLength(1);
    expect(ports.uploads[0].filename).toBe("logo-blue.png");
    expect(Array.from(ports.uploads[0].bytes)).toEqual([9, 9, 9]);
    expect(images.calls[0]).toMatchObject({ width: 1200, height: 630, fit: "contain", background: "#ffffff" });
    // Audit records the rendered PNG at the requested canvas.
    expect(ports.audits).toHaveLength(1);
    expect(ports.audits[0]).toMatchObject({ output_format: "png", width: 1200, height: 630, assetLabel: "logo-blue.png" });
  });

  it("rejects an oversized custom render before calling Images", async () => {
    const asset = makeAsset({ format: "png", source_path: "TNL/logo.png" });
    const repo = fakeRepo([asset]);
    const resolver = {
      resolve: async (): Promise<ResolvedAsset> => ({
        asset, needsCustomSize: true, renderNaturalPng: false,
        requestedWidth: 99999, requestedHeight: 99999, background: null,
        paddingRatio: null, requestedByUserId: "u1", purpose: null, purposeUrl: null,
      }),
    } as any;
    const conversations = makeConversations();
    const ports = makePorts();
    const images = fakeImages();
    await conversations.set("u1", seedPurposeState("tnl"));

    await handleMessage("99999x99999", "u1", deps(repo, resolver, fakeParser("tnl"), conversations, images), ports);

    expect(ports.uploads).toHaveLength(0);
    expect(images.calls).toHaveLength(0);
    expect(ports.said.some((m) => /4096|超過/.test(m.text || ""))).toBe(true);
  });

  it("asks for a brand when none is resolved", async () => {
    const repo = fakeRepo([]);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();

    await handleMessage("給我 logo", "u1", deps(repo, resolver, fakeParser(null), conversations), ports);

    expect(ports.uploads).toHaveLength(0);
    expect(conversations.set).toHaveBeenCalled();
    expect(ports.said[0].text).toMatch(/哪個品牌/);
  });

  it("reports no-match when the brand resolves but no asset is found", async () => {
    const repo = fakeRepo([]); // findAssets returns nothing
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();
    await conversations.set("u1", seedPurposeState("tnl"));

    await handleMessage("放在官網", "u1", deps(repo, resolver, fakeParser("tnl"), conversations), ports);

    expect(ports.uploads).toHaveLength(0);
    expect(ports.said.some((m) => /找不到/.test(m.text || ""))).toBe(true);
  });
});
