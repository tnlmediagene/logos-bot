import { ConversationState } from "./conversation";
import { CatalogReader } from "../catalog/catalog-reader";
import { colorLabel } from "./labels";
import { SlackMessage, buildErrorMessage, buildQuestionMessage } from "./response-builder";

export interface NoMatchResult {
  message: SlackMessage;
  /**
   * When the fallback offers re-selection buttons, the (adjusted) state to
   * persist so the button click can resume the conversation. Null when the
   * message is a dead-end and no state should be kept.
   */
  state: ConversationState | null;
}

/**
 * Async, D1-backed counterpart of `no-match.ts`'s `buildNoMatchMessage` (which
 * depends on the sync `CatalogRepo` and stays on the offline-scan/Node side).
 * Same logic: when a requested color doesn't exist for the brand, name the
 * missing color, list what the brand actually has, and attach buttons so the
 * user can switch with one click (handled by the Worker's `select_color_*`
 * block action).
 */
export async function buildNoMatchMessage(
  state: ConversationState,
  repo: CatalogReader
): Promise<NoMatchResult> {
  const brandId = state.resolvedBrandId;
  if (!brandId) {
    return { message: buildErrorMessage("找不到符合條件的 Logo，請嘗試其他描述。"), state: null };
  }

  const brand = await repo.getBrandById(brandId);
  const brandName = brand?.display_name || "這個品牌";

  const requestedColor = state.parsed.color;
  if (requestedColor) {
    // Which colors does this brand actually have, honoring the other filters
    // the user already gave (format / language / asset type) but ignoring color?
    const withoutColor = await repo.findAssets({
      brand_id: brandId,
      ...(state.parsed.format ? { format: state.parsed.format } : {}),
      ...(state.parsed.language ? { language: state.parsed.language } : {}),
      ...(state.parsed.asset_type ? { asset_type: state.parsed.asset_type } : {}),
    });
    const availableColors = [...new Set(withoutColor.filter((a) => a.color).map((a) => a.color!))];

    if (availableColors.length > 0 && !availableColors.includes(requestedColor)) {
      // Clear the unmatched color so the retained state can accept a new pick.
      const nextState: ConversationState = {
        ...state,
        parsed: { ...state.parsed, color: null },
      };
      const colorList = availableColors.map(colorLabel).join("、");
      const message = buildQuestionMessage({
        text: `找不到 ${brandName} 的${colorLabel(requestedColor)} Logo。這個品牌目前有這些版本：${colorList}`,
        field: "color",
        options: availableColors.map((c) => ({ label: colorLabel(c), value: c })),
      });
      return { message, state: nextState };
    }
  }

  return {
    message: buildErrorMessage(`找不到符合條件的 ${brandName} Logo，可能是這個品牌沒有你指定的顏色或格式，請換個描述再試。`),
    state: null,
  };
}
