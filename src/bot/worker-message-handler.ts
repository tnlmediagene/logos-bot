import { RequestParser } from "./request-parser";
import { ConversationManager, ConversationState } from "./conversation";
import { KvConversationStore } from "./kv-conversation-store";
import { AssetResolver, ResolvedAsset } from "./asset-resolver";
import { CatalogReader } from "../catalog/catalog-reader";
import { DriveClient } from "../scanner/drive-client";
import {
  renderSvgNatural,
  renderCustomSize,
  validateDimensions,
  ImagesBindingLike,
} from "../renderer/worker-renderer";
import { buildQuestionMessage, buildErrorMessage, buildDeliveryMessage, buildWhiteLogoWarning, SlackMessage } from "./response-builder";
import { buildNoMatchMessage } from "./worker-no-match";
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
  const { parser, conversationManager, conversations } = deps;

  const pendingState = await conversations.get(userId);

  // --- Awaiting the mandatory purpose reply. Purpose is unconditionally the
  // LAST gate `getNextQuestion` ever asks (see conversation.ts), so once it's
  // answered there is nothing left to ask — go straight to resolve. ---
  if (pendingState?.awaitingPurpose) {
    const state = conversationManager.applyPurposeInput(pendingState, text);
    if (!state) {
      await ports.say(buildErrorMessage("請簡述這個 Logo 的用途（若有連結可直接貼上網址）才能取得檔案。"));
      return;
    }
    await resolveOrNoMatch(state, userId, deps, ports);
    return;
  }

  // --- Awaiting a free-text custom size reply (e.g. "800x600"). A later
  // question (background) may still follow, so check before resolving. ---
  if (pendingState?.awaitingCustomSize) {
    const state = conversationManager.applyCustomSizeInput(pendingState, text);
    if (!state) {
      await ports.say(buildErrorMessage("請以「寬x高」輸入尺寸，例如 800x600。"));
      return;
    }
    const question = await computeQuestion(state, deps);
    if (question) {
      await conversations.set(userId, state);
      await ports.say(buildQuestionMessage(question));
      return;
    }
    await resolveOrNoMatch(state, userId, deps, ports);
    return;
  }

  // --- A fresh request. ---
  const parsed = parser.parseUserRequest(text);
  const state = conversationManager.startConversation(userId, "", parsed);
  if (parsed.brand) state.resolvedBrandId = parsed.brand;

  const question = await computeQuestion(state, deps);

  if (!question && !state.resolvedBrandId) {
    await conversations.set(userId, state);
    await ports.say({ text: "你要哪個品牌的 Logo？請直接輸入品牌名稱（例如 INSIDE、關鍵評論網、TNL Mediagene）。" });
    return;
  }

  if (question) {
    await conversations.set(userId, state);
    await ports.say(buildQuestionMessage(question));
    return;
  }

  if (conversationManager.isComplete(state)) {
    await resolveOrNoMatch(state, userId, deps, ports);
    return;
  }

  await ports.say(buildErrorMessage("無法辨識品牌，請指定品牌名稱，例如「TNL」或「關鍵評論網」。"));
}

/**
 * Handle a `select_<field>_<value>` block action (a question's button click):
 * apply the answer to the stored conversation state, then ask the next
 * question or resolve + deliver.
 */
export async function handleBlockAction(
  userId: string,
  actionId: string,
  value: string,
  deps: MessageDeps,
  ports: MessagePorts
): Promise<void> {
  const { conversationManager, conversations } = deps;

  if (typeof value !== "string" || !actionId.startsWith("select_")) return;
  // action_id is `select_${field}_${value}`. Field names contain underscores
  // (e.g. asset_type, brand_id) and so do some values, so a regex split is
  // ambiguous. The button's own `value` is authoritative — strip it (plus the
  // "select_" prefix and the joining "_") to recover the field exactly.
  const field = actionId.slice("select_".length, actionId.length - value.length - 1);
  if (!field) return;

  const pendingState = await conversations.get(userId);
  if (!pendingState) {
    await ports.say(buildErrorMessage("對話已過期，請重新輸入品牌名稱。"));
    return;
  }

  const updated = conversationManager.applyAnswer(pendingState, field, value);
  const question = await computeQuestion(updated, deps);

  if (question) {
    await conversations.set(userId, updated);
    await ports.say(buildQuestionMessage(question));
    return;
  }

  // No more questions. `isComplete` is normally true here (purpose is always
  // asked before any button-driven path can run out of questions), but a
  // brand with literally zero assets can reach here with it still false — in
  // that case resolve anyway so the user gets a clear no-match message rather
  // than silence.
  await resolveOrNoMatch(updated, userId, deps, ports);
}

/** Recompute the next guided question for the given state (brand/asset lookups). */
async function computeQuestion(state: ConversationState, deps: MessageDeps) {
  const { conversationManager, repo } = deps;
  const brands = state.resolvedBrandId
    ? [await repo.getBrandById(state.resolvedBrandId)].filter((b): b is NonNullable<typeof b> => b !== null)
    : (await Promise.all(state.parsed.brandCandidates.map((id) => repo.getBrandById(id)))).filter(
        (b): b is NonNullable<typeof b> => b !== null
      );
  const assets = state.resolvedBrandId ? await repo.getActiveAssets(state.resolvedBrandId) : [];
  return conversationManager.getNextQuestion(state, brands, assets);
}

/** Resolve the asset for a complete state; deliver it, or report no-match. */
async function resolveOrNoMatch(
  state: ConversationState,
  userId: string,
  deps: MessageDeps,
  ports: MessagePorts
): Promise<void> {
  const { conversations, resolver, repo } = deps;
  const result = await resolver.resolve(state);
  if (result) {
    await conversations.delete(userId);
    await deliver(result, deps, ports);
    return;
  }
  const noMatch = await buildNoMatchMessage(state, repo);
  if (noMatch.state) await conversations.set(userId, noMatch.state);
  else await conversations.delete(userId);
  await ports.say(noMatch.message);
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
