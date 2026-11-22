import { SlackApp } from "slack-cloudflare-workers";
import type { Env } from "./env";
import brandsConfig from "../config/brands.json";
import { D1CatalogRepo } from "./catalog/d1-catalog-repo";
import { KvConversationStore } from "./bot/kv-conversation-store";
import { AssetResolver } from "./bot/asset-resolver";
import { BrandMatcher } from "./bot/brand-matcher";
import { RequestParser } from "./bot/request-parser";
import { ConversationManager } from "./bot/conversation";
import { DriveClient } from "./scanner/drive-client";
import { createGoogleAuth } from "./google-auth";
import { handleMessage, MessagePorts } from "./bot/worker-message-handler";
import { createWorkerAuditSink } from "./bot/worker-audit";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Comma/space-separated reviewer channel list → trimmed non-empty entries. */
function parseNotifyChannels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the Slack app for the Worker.
 *
 * Uses `slack-cloudflare-workers`' `SlackApp` in bot-token mode. The framework
 * handles URL verification + request-signature verification inside `app.run()`.
 *
 * Each inbound DM builds the pipeline from `env` (D1 repo, KV conversation
 * store, Drive client, brand matcher, Images binding) and drives parse →
 * question → resolve → deliver. The brand matcher is rebuilt per request from
 * the live brand table (tens of rows — cheap). Delivery renders custom sizes /
 * PNG-from-SVG via svg2png-wasm + Cloudflare Images.
 *
 * `ctx` is threaded in so the delivery audit (D1 write + reviewer-channel
 * notice) runs via `ctx.waitUntil(...)` after the response, never delaying or
 * failing the user's delivery.
 */
export function createSlackApp(env: Env, ctx?: ExecutionContext): SlackApp<Env> {
  const app = new SlackApp({
    env,
    routes: { events: "/slack/events" },
  });

  const notifyChannels = parseNotifyChannels(env.AUDIT_NOTIFY_CHANNELS);

  app.message(undefined, async ({ context, payload }) => {
    if (payload.subtype !== undefined) return;
    const text = payload.text?.trim();
    const userId = payload.user;
    const channelId = payload.channel;
    if (!text || !userId || !channelId) return;

    const repo = new D1CatalogRepo(env.DB);
    const conversations = new KvConversationStore(env.CONVERSATIONS);
    const driveClient = new DriveClient(
      createGoogleAuth(env.GOOGLE_SERVICE_ACCOUNT_KEY, DRIVE_SCOPE)
    );

    // Brand matcher is built from the live brand table + the bundled aliases.
    const allBrands = await repo.getAllBrands();
    const matcher = new BrandMatcher(allBrands, brandsConfig as any);
    const parser = new RequestParser(matcher);
    const conversationManager = new ConversationManager();
    const resolver = new AssetResolver(repo);

    // Audit sink writes the D1 deliveries row + posts reviewer notices; run in
    // the background via ctx.waitUntil so it never delays or fails delivery.
    const auditSink = createWorkerAuditSink(repo, context.client as any, notifyChannels);

    const ports: MessagePorts = {
      say: async (msg) => {
        await context.say({ ...msg } as any);
      },
      uploadFile: async (bytes, filename, title) => {
        // The API's file field is Blob | ArrayBuffer; hand it a fresh
        // ArrayBuffer sized to the exact bytes.
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        await context.client.files.uploadV2({
          channel_id: channelId,
          file: ab,
          filename,
          title,
        });
      },
      audit: (event) => {
        const p = auditSink(event);
        // Prefer the real ExecutionContext.waitUntil; detach with its own catch
        // when ctx is absent (keeps a stray rejection from going unhandled).
        if (ctx?.waitUntil) ctx.waitUntil(p);
        else void p.catch((err) => console.error("audit failed:", err));
      },
    };

    await handleMessage(text, userId, {
      parser,
      conversationManager,
      conversations,
      resolver,
      repo,
      driveClient,
      images: env.IMAGES as any,
      maxOutputSize: Number(env.MAX_OUTPUT_SIZE) || 4096,
    }, ports);
  });

  return app;
}
