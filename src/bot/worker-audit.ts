import { DeliveryRecord } from "../catalog/catalog-repo";
import { CatalogReader } from "../catalog/d1-catalog-repo";

/** A delivery to audit: the DB row plus a human label for the Slack notice. */
export type AuditEvent = DeliveryRecord & { assetLabel: string };

/** Minimal Slack client surface the notice needs (slack-cloudflare-workers client). */
export interface SlackPostLike {
  chat: { postMessage: (args: { channel: string; text: string }) => Promise<unknown> };
}

/**
 * Build the Worker delivery-audit sink. Mirrors the Node `createAuditSink` but
 * uses the async D1 repo and the slack-cloudflare-workers client.
 *
 * It always writes the D1 deliveries row (the source of truth) first, then
 * best-effort posts a notice to each configured reviewer channel. Neither step
 * may throw into delivery: the file has already been handed to the user, so a
 * failed audit is logged and swallowed, never surfaced as an error.
 *
 * The caller runs this inside `ctx.waitUntil(...)` so the notice does not delay
 * the user's response.
 */
export function createWorkerAuditSink(
  repo: CatalogReader,
  client: SlackPostLike,
  notifyChannels: string[]
): (event: AuditEvent) => Promise<void> {
  return async (event: AuditEvent) => {
    const { assetLabel, ...row } = event;

    try {
      await repo.recordDelivery(row);
    } catch (err) {
      console.error("Failed to record delivery audit row:", err);
    }

    if (notifyChannels.length === 0) return;

    let brandName: string | null = null;
    if (row.brand_id) {
      try {
        brandName = (await repo.getBrandById(row.brand_id))?.display_name ?? null;
      } catch {
        brandName = null;
      }
    }
    const text = buildNotice(event, brandName ?? row.brand_id ?? "(未知品牌)", assetLabel);
    for (const channel of notifyChannels) {
      try {
        await client.chat.postMessage({ channel, text });
      } catch (err) {
        console.error(`Failed to notify audit channel ${channel}:`, err);
      }
    }
  };
}

function buildNotice(row: DeliveryRecord, brandName: string, assetLabel: string): string {
  const size = row.width && row.height ? `${row.width}×${row.height}` : "原始尺寸";
  const fmt = (row.output_format ?? "").toUpperCase();
  const lines = [
    "🧾 *Logo 取用紀錄*",
    `• 取用者：<@${row.slack_user_id}>`,
    `• 品牌：${brandName}`,
    `• 檔案：\`${assetLabel}\`（${fmt}｜${size}）`,
    `• 用途：${row.purpose}`,
  ];
  if (row.purpose_url) lines.push(`• 連結：${row.purpose_url}`);
  return lines.join("\n");
}
