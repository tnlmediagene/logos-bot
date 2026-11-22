import { RequestParser } from "./request-parser";
import { ConversationManager } from "./conversation";
import { KvConversationStore } from "./kv-conversation-store";
import { AssetResolver, ResolvedAsset } from "./asset-resolver";
import { CatalogReader } from "../catalog/d1-catalog-repo";
import { DriveClient } from "../scanner/drive-client";
import {
  renderSvgNatural,
  renderCustomSize,
  validateDimensions,
  ImagesBindingLike,
} from "../renderer/worker-renderer";
import { buildQuestionMessage, buildErrorMessage, buildDeliveryMessage, buildWhiteLogoWarning, SlackMessage } from "./response-builder";
import { AuditEvent } from "./worker-audit";

/**
 * The Slack side-effects the Worker pipeline needs, injected so this logic is
 * testable without the live Slack client.
 */
export interface MessagePorts {
  /** Post a message back to the user. */
  say: (msg: SlackMessage | { text: string }) => Promise<void>;
  /** Upload file bytes to the conversation. */
  uploadFile: (bytes: Uint8Array, filename: string, title: string) => Promise<void>;
  /**
   * Record a delivery for audit. Best-effort and non-blocking — the slack-app
   * wires it to `ctx.waitUntil(...)` so the D1 write + reviewer notice run in
   * the background and never delay or fail the user's delivery. Optional so
   * tests can omit it.
   */
  audit?: (event: AuditEvent) => void;
}

export interface MessageDeps {
  parser: RequestParser;
  conversationManager: ConversationManager;
  conversations: KvConversationStore;
  resolver: AssetResolver;
  repo: CatalogReader;
  driveClient: DriveClient;
  /** Cloudflare Images binding — needed only for custom-size renders. */
  images: ImagesBindingLike;
  /** Max allowed output dimension (MAX_OUTPUT_SIZE). */
  maxOutputSize: number;
}

/**
 * Handle one inbound DM text, driving the guided flow: parse → (brand/attribute
 * questions) → resolve → deliver. State lives in KV between turns.
 *
 * Delivery handles all three paths: direct download (SVG/AI/PNG as-is), natural
 * PNG (svg2png-wasm), and custom size (svg2png-wasm + Cloudflare Images).
 */
export async function handleMessage(
  text: string,
  userId: string,
  deps: MessageDeps,
  ports: MessagePorts
): Promise<void> {
  const { parser, conversationManager, conversations, resolver, repo, driveClient } = deps;

  const pendingState = await conversations.get(userId);

  // --- Awaiting the mandatory purpose reply: apply, then resolve + deliver. ---
  if (pendingState?.awaitingPurpose) {
    const state = conversationManager.applyPurposeInput(pendingState, text);
    if (!state) {
      await ports.say(buildErrorMessage("請簡述這個 Logo 的用途（若有連結可直接貼上網址）才能取得檔案。"));
      return;
    }
    const result = await resolver.resolve(state);
    if (!result) {
      await conversations.delete(userId);
      await ports.say(await buildNoMatch(state.resolvedBrandId, repo));
      return;
    }
    await conversations.delete(userId);
    await deliver(result, deps, ports);
    return;
  }

  // --- A fresh request. ---
  const parsed = parser.parseUserRequest(text);
  const state = conversationManager.startConversation(userId, "", parsed);
  if (parsed.brand) state.resolvedBrandId = parsed.brand;

  const brands = parsed.brandCandidates
    .map((id) => repo.getBrandById(id));
  // repo.getBrandById is async on D1 — resolve the candidates first.
  const resolvedBrands = (await Promise.all(brands)).filter(
    (b): b is NonNullable<typeof b> => b !== null
  );

  const assets = state.resolvedBrandId ? await repo.getActiveAssets(state.resolvedBrandId) : [];
  const question = conversationManager.getNextQuestion(state, resolvedBrands, assets);

  if (!question && !state.resolvedBrandId) {
    await conversations.set(userId, state);
    await ports.say({ text: "你要哪個品牌的 Logo？請直接輸入品牌名稱（例如 INSIDE、關鍵評論網、TNL Mediagene）。" });
    return;
  }

  if (!question && conversationManager.isComplete(state)) {
    const result = await resolver.resolve(state);
    if (result) {
      await deliver(result, deps, ports);
    } else {
      await ports.say(await buildNoMatch(state.resolvedBrandId, repo));
    }
    return;
  }

  if (question) {
    await conversations.set(userId, state);
    await ports.say(buildQuestionMessage(question));
    return;
  }

  await ports.say(buildErrorMessage("無法辨識品牌，請指定品牌名稱，例如「TNL」或「關鍵評論網」。"));
}

/**
 * Deliver a resolved asset. Three paths:
 *  - direct download: upload the original bytes (SVG / AI, or a PNG with no
 *    custom size requested);
 *  - natural PNG: rasterise the SVG at its own size (svg2png-wasm);
 *  - custom size: render to the requested canvas (svg2png-wasm + CF Images).
 */
async function deliver(result: ResolvedAsset, deps: MessageDeps, ports: MessagePorts): Promise<void> {
  const { asset } = result;
  const fileName = asset.source_path.split("/").pop() || asset.id;
  // A rendered PNG's filename ends in .png, not the source's .svg.
  const pngName = fileName.replace(/\.[^.]+$/, "") + ".png";

  // --- Natural-size PNG: rasterise the SVG at its own size. ---
  if (result.renderNaturalPng) {
    const source = await deps.driveClient.downloadFile(asset.source_drive_file_id);
    const rendered = await renderSvgNatural(source);
    await ports.uploadFile(rendered.bytes, pngName, pngName);
    if (asset.color === "white" && asset.background === "transparent") {
      await ports.say(buildWhiteLogoWarning());
    }
    await ports.say(buildDeliveryMessage(asset, { width: rendered.actualWidth, height: rendered.actualHeight }));
    emitAudit(result, ports, "png", rendered.actualWidth, rendered.actualHeight, pngName);
    return;
  }

  // --- Custom size: render to the requested canvas. ---
  if (result.needsCustomSize) {
    const width = result.requestedWidth!;
    const height = result.requestedHeight!;
    const validation = validateDimensions(width, height, deps.maxOutputSize);
    if (!validation.valid) {
      await ports.say(buildErrorMessage(validation.error!));
      return;
    }
    const source = await deps.driveClient.downloadFile(asset.source_drive_file_id);
    const rendered = await renderCustomSize(
      {
        source,
        sourceFormat: asset.format === "svg" ? "svg" : "png",
        width,
        height,
        background: result.background && result.background !== "transparent" ? result.background : "transparent",
        paddingRatio: result.paddingRatio ?? 0,
      },
      deps.images
    );
    await ports.uploadFile(rendered.bytes, pngName, pngName);
    if (
      asset.color === "white" &&
      asset.background === "transparent" &&
      (!result.background || result.background === "transparent")
    ) {
      await ports.say(buildWhiteLogoWarning());
    }
    await ports.say(buildDeliveryMessage(asset, { width, height }));
    emitAudit(result, ports, "png", width, height, pngName);
    return;
  }

  // --- Direct download: upload the original file bytes. ---
  const bytes = await deps.driveClient.downloadFile(asset.source_drive_file_id);
  await ports.uploadFile(bytes, fileName, fileName);

  if (asset.color === "white" && asset.background === "transparent") {
    await ports.say(buildWhiteLogoWarning());
  }
  await ports.say(buildDeliveryMessage(asset));
  emitAudit(result, ports, asset.format, null, null, fileName);
}

/** Build the audit event and hand it to the (background) audit port. */
function emitAudit(
  result: ResolvedAsset,
  ports: MessagePorts,
  outputFormat: string,
  width: number | null,
  height: number | null,
  assetLabel: string
): void {
  if (!ports.audit) return;
  ports.audit({
    slack_user_id: result.requestedByUserId,
    brand_id: result.asset.brand_id,
    asset_id: result.asset.id,
    output_format: outputFormat,
    width,
    height,
    background: result.background,
    padding_ratio: result.paddingRatio,
    purpose: result.purpose ?? "",
    purpose_url: result.purposeUrl,
    assetLabel,
  });
}

/** Minimal async no-match message (rich color-fallback buttons come later). */
async function buildNoMatch(brandId: string | null, repo: CatalogReader): Promise<SlackMessage> {
  if (!brandId) {
    return buildErrorMessage("找不到符合條件的 Logo，請嘗試其他描述。");
  }
  const brand = await repo.getBrandById(brandId);
  const brandName = brand?.display_name || "這個品牌";
  return buildErrorMessage(
    `找不到符合條件的 ${brandName} Logo，可能是這個品牌沒有你指定的顏色或格式，請換個描述再試。`
  );
}
