import { describe, it, expect, vi } from "vitest";
import { handleMessage, handleBlockAction, MessageDeps, MessagePorts } from "../../src/bot/worker-message-handler";
import { ConversationManager } from "../../src/bot/conversation";
import { AssetResolver, ResolvedAsset } from "../../src/bot/asset-resolver";
import { AssetRecord, BrandRecord } from "../../src/catalog/catalog-repo";

// renderCustomSize calls real svg2png-wasm, whose .wasm import only resolves
// inside Wrangler's bundler (fails under plain vitest with "Cannot find
// package 'wbg'" — see worker-renderer.test.ts). Mocked here so the custom-
// size delivery test below can exercise handleMessage's own orchestration
// (filename, audit, upload) without needing the real rasteriser; the
// rendering itself is covered by worker-renderer.test.ts's buildComposedSvg
// tests plus manual verification via wrangler dev.
vi.mock("../../src/renderer/worker-renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/worker-renderer")>();
  return {
    ...actual,
    renderCustomSize: vi.fn(async () => ({ bytes: new Uint8Array([9, 9, 9]), actualWidth: 1200, actualHeight: 630 })),
  };
});

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

const TEAM = "T_TEAM1";
const CHANNEL = "C_CHANNEL1";
const KEY = `${TEAM}:${CHANNEL}:u1`;

function makeConversations() {
  const store = new Map<string, any>();
  return {
    get: vi.fn(async (u: string) => store.get(u)),
    set: vi.fn(async (u: string, s: any) => { store.set(u, s); }),
    delete: vi.fn(async (u: string) => { store.delete(u); }),
  };
}

function deps(repo: any, resolver: AssetResolver, parser: any, conversations: any): MessageDeps {
  return {
    parser,
    conversationManager: new ConversationManager(),
    conversations,
    resolver,
    repo,
    driveClient: { downloadFile: vi.fn(async () => new Uint8Array([1, 2, 3])) } as any,
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

    await handleMessage("TNL logo", "u1", TEAM, CHANNEL, deps(repo, resolver, fakeParser("tnl"), conversations), ports);

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
    await handleMessage("TNL svg logo", "u1", TEAM, CHANNEL, d, ports);
    // Turn 2: the purpose reply resolves + delivers.
    await handleMessage("放在官網首頁", "u1", TEAM, CHANNEL, d, ports);

    expect(ports.uploads).toHaveLength(1);
    expect(ports.uploads[0].filename).toBe("logo-blue.svg");
    expect(Array.from(ports.uploads[0].bytes)).toEqual([1, 2, 3]);
    expect(conversations.delete).toHaveBeenCalledWith(KEY);
    // Audit fires for the delivered asset (direct download → source format).
    expect(ports.audits).toHaveLength(1);
    expect(ports.audits[0]).toMatchObject({ slack_user_id: "u1", brand_id: "tnl", asset_id: "a1", output_format: "svg", assetLabel: "logo-blue.svg" });
  });

  it("renders a custom size (svg2png-wasm mocked — real rasterising is covered elsewhere) and uploads the PNG", async () => {
    const asset = makeAsset({ format: "png", source_path: "TNL/logo-blue.png" });
    const repo = fakeRepo([asset]);
    const resolver = {
      resolve: async (): Promise<ResolvedAsset> => ({
        asset, needsCustomSize: true, renderNaturalPng: false,
        requestedWidth: 1200, requestedHeight: 630, background: "white",
        paddingRatio: null, requestedByUserId: "u1", purpose: null, purposeUrl: null,
      }),
    } as any;
    const conversations = makeConversations();
    const ports = makePorts();
    await conversations.set(KEY, seedPurposeState("tnl"));

    await handleMessage("1200x630", "u1", TEAM, CHANNEL, deps(repo, resolver, fakeParser("tnl"), conversations), ports);

    // Rendered PNG uploaded with a .png filename (the mocked renderer's bytes).
    expect(ports.uploads).toHaveLength(1);
    expect(ports.uploads[0].filename).toBe("logo-blue.png");
    expect(Array.from(ports.uploads[0].bytes)).toEqual([9, 9, 9]);
    // Audit records the rendered PNG at the requested canvas.
    expect(ports.audits).toHaveLength(1);
    expect(ports.audits[0]).toMatchObject({ output_format: "png", width: 1200, height: 630, assetLabel: "logo-blue.png" });
  });

  it("rejects an oversized custom render before ever rendering", async () => {
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
    await conversations.set(KEY, seedPurposeState("tnl"));

    await handleMessage("99999x99999", "u1", TEAM, CHANNEL, deps(repo, resolver, fakeParser("tnl"), conversations), ports);

    expect(ports.uploads).toHaveLength(0);
    expect(ports.said.some((m) => /4096|超過/.test(m.text || ""))).toBe(true);
  });

  it("asks for a brand when none is resolved", async () => {
    const repo = fakeRepo([]);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();

    await handleMessage("給我 logo", "u1", TEAM, CHANNEL, deps(repo, resolver, fakeParser(null), conversations), ports);

    expect(ports.uploads).toHaveLength(0);
    expect(conversations.set).toHaveBeenCalled();
    expect(ports.said[0].text).toMatch(/哪個品牌/);
  });

  it("reports no-match when the brand resolves but no asset is found", async () => {
    const repo = fakeRepo([]); // findAssets returns nothing
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();
    await conversations.set(KEY, seedPurposeState("tnl"));

    await handleMessage("放在官網", "u1", TEAM, CHANNEL, deps(repo, resolver, fakeParser("tnl"), conversations), ports);

    expect(ports.uploads).toHaveLength(0);
    expect(ports.said.some((m) => /找不到/.test(m.text || ""))).toBe(true);
  });
});

describe("handleBlockAction (select_ button clicks)", () => {
  it("applies the answer and asks the next question, persisting state", async () => {
    // Two colors so, after picking a format, the color question is still open.
    const assets = [
      makeAsset({ id: "a1", format: "svg", color: "blue" }),
      makeAsset({ id: "a2", format: "svg", color: "white" }),
    ];
    const repo = fakeRepo(assets);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();
    // Mid-flow: brand resolved, nothing else answered yet.
    await conversations.set(KEY, {
      userId: "u1", channelId: "", resolvedBrandId: "tnl", resolvedAssetId: null,
      awaitingCustomSize: false, awaitingPurpose: false, sizeResolved: false,
      backgroundResolved: false, purpose: null, purposeUrl: null,
      step: "format_select", startedAt: "2026-10-01T00:00:00.000Z",
      parsed: {
        brand: "tnl", brandCandidates: ["tnl"], format: null, color: null,
        language: null, asset_type: null, layout: null, background: null,
        width: null, height: null, paddingRatio: null, raw_text: "x",
      },
    });

    await handleBlockAction(
      "u1", TEAM, CHANNEL, "select_format_svg", "svg",
      deps(repo, resolver, fakeParser("tnl"), conversations), ports
    );

    expect(ports.uploads).toHaveLength(0);
    expect(conversations.set).toHaveBeenCalled();
    // Next question should be about color (two colors remain for svg).
    expect(ports.said[0].text).toMatch(/顏色/);
  });

  it("reports the conversation expired when no state is pending", async () => {
    const repo = fakeRepo([]);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();

    await handleBlockAction(
      "u1", TEAM, CHANNEL, "select_format_svg", "svg",
      deps(repo, resolver, fakeParser("tnl"), conversations), ports
    );

    expect(ports.said.some((m) => /對話已過期/.test(m.text || ""))).toBe(true);
  });

  it("reports no-match when the last answer leaves zero assets", async () => {
    const repo = fakeRepo([]); // findAssets/getActiveAssets return nothing
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();
    // Purpose already answered; only the color pick is left (and that leads
    // nowhere, since no assets exist at all).
    await conversations.set(KEY, {
      ...seedPurposeState("tnl"),
      awaitingPurpose: false,
      purpose: "social post",
    });

    await handleBlockAction(
      "u1", TEAM, CHANNEL, "select_color_blue", "blue",
      deps(repo, resolver, fakeParser("tnl"), conversations), ports
    );

    expect(ports.uploads).toHaveLength(0);
    expect(ports.said.some((m) => /找不到/.test(m.text || ""))).toBe(true);
  });

  it("ignores a malformed action (missing value) without throwing", async () => {
    const repo = fakeRepo([]);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const ports = makePorts();

    await handleBlockAction(
      "u1", TEAM, CHANNEL, "select_format_svg", undefined as any,
      deps(repo, resolver, fakeParser("tnl"), conversations), ports
    );

    expect(ports.said).toHaveLength(0);
  });

  it("does not leak conversation state between two workspaces with the same Slack user id", async () => {
    // Same literal userId ("u1") in two different installed teams — Slack
    // ids are only unique within their own workspace, so this collision is
    // realistic once more than one team installs the bot.
    const repo = fakeRepo([makeAsset({ format: "svg" })]);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const portsA = makePorts();
    const portsB = makePorts();

    // Team A starts a guided flow for "u1" (asks a question, persists state).
    await handleMessage("TNL logo", "u1", "T_TEAMA", CHANNEL, deps(repo, resolver, fakeParser("tnl"), conversations), portsA);
    // Team B's "u1" (a different, unrelated person) starts completely fresh.
    await handleMessage("TNL logo", "u1", "T_TEAMB", CHANNEL, deps(repo, resolver, fakeParser("tnl"), conversations), portsB);

    // Each team's state lives under its own key — neither overwrote the other.
    expect(await conversations.get(`T_TEAMA:${CHANNEL}:u1`)).toBeDefined();
    expect(await conversations.get(`T_TEAMB:${CHANNEL}:u1`)).toBeDefined();
    expect(conversations.set).toHaveBeenCalledWith(`T_TEAMA:${CHANNEL}:u1`, expect.anything());
    expect(conversations.set).toHaveBeenCalledWith(`T_TEAMB:${CHANNEL}:u1`, expect.anything());
  });

  it("does not leak conversation state between two channels for the same team and user", async () => {
    // Same team + same Slack user id, but two different conversation
    // surfaces (e.g. their 1:1 DM vs. a group DM they share with the bot) —
    // each must get its own independent state.
    const repo = fakeRepo([makeAsset({ format: "svg" })]);
    const resolver = new AssetResolver(repo as any);
    const conversations = makeConversations();
    const portsA = makePorts();
    const portsB = makePorts();

    await handleMessage("TNL logo", "u1", TEAM, "C_CHANNELA", deps(repo, resolver, fakeParser("tnl"), conversations), portsA);
    await handleMessage("TNL logo", "u1", TEAM, "C_CHANNELB", deps(repo, resolver, fakeParser("tnl"), conversations), portsB);

    expect(await conversations.get(`${TEAM}:C_CHANNELA:u1`)).toBeDefined();
    expect(await conversations.get(`${TEAM}:C_CHANNELB:u1`)).toBeDefined();
    expect(conversations.set).toHaveBeenCalledWith(`${TEAM}:C_CHANNELA:u1`, expect.anything());
    expect(conversations.set).toHaveBeenCalledWith(`${TEAM}:C_CHANNELB:u1`, expect.anything());
  });
});
