import { SlackOAuthApp, KVInstallationStore } from "slack-cloudflare-workers";
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
import { handleMessage, handleBlockAction, MessageDeps, MessagePorts } from "./bot/worker-message-handler";
import { createWorkerAuditSink, AuditEvent } from "./bot/worker-audit";
import type { SlackMessage } from "./bot/response-builder";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Comma/space-separated reviewer channel list → trimmed non-empty entries. */
function parseNotifyChannels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the per-request pipeline from `env`: D1 repo, KV conversation store,
 * Drive client, and a brand matcher rebuilt from the live brand table (tens
 * of rows — cheap). Shared by both the message handler and the button-click
 * (block action) handler below, since both drive the same guided flow.
 */
async function buildDeps(env: Env): Promise<{ deps: MessageDeps; repo: D1CatalogRepo }> {
  const repo = new D1CatalogRepo(env.DB);
  const conversations = new KvConversationStore(env.CONVERSATIONS);
  const driveClient = new DriveClient(
    createGoogleAuth(env.GOOGLE_SERVICE_ACCOUNT_KEY, DRIVE_SCOPE)
  );

  const allBrands = await repo.getAllBrands();
  const matcher = new BrandMatcher(allBrands, brandsConfig as any);
  const parser = new RequestParser(matcher);
  const conversationManager = new ConversationManager();
  const resolver = new AssetResolver(repo);

  const deps: MessageDeps = {
    parser,
    conversationManager,
    conversations,
    resolver,
    repo,
    driveClient,
    images: env.IMAGES as any,
    maxOutputSize: Number(env.MAX_OUTPUT_SIZE) || 4096,
  };
  return { deps, repo };
}

/**
 * Build the Slack side-effect ports shared by both handlers. `post` differs by
 * call site (`context.say` for a message event, `context.respond` for a block
 * action, since the latter's context type only guarantees `respond`), but the
 * upload + audit wiring is identical.
 */
function buildPorts(
  post: (msg: SlackMessage | { text: string }) => Promise<unknown>,
  uploadFile: (ab: ArrayBuffer, filename: string, title: string) => Promise<unknown>,
  auditSink: (event: AuditEvent) => Promise<void>,
  ctx: ExecutionContext | undefined
): MessagePorts {
  return {
    say: async (msg) => {
      await post(msg);
    },
    uploadFile: async (bytes, filename, title) => {
      // The API's file field is Blob | ArrayBuffer; hand it a fresh
      // ArrayBuffer sized to the exact bytes.
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await uploadFile(ab, filename, title);
    },
    audit: (event) => {
      const p = auditSink(event);
      // Prefer the real ExecutionContext.waitUntil; detach with its own catch
      // when ctx is absent (keeps a stray rejection from going unhandled).
      if (ctx?.waitUntil) ctx.waitUntil(p);
      else void p.catch((err) => console.error("audit failed:", err));
    },
  };
}

/**
 * Build the Slack app for the Worker.
 *
 * Uses `slack-cloudflare-workers`' `SlackOAuthApp` so any workspace in the
 * TNL Mediagene family can self-install via `/slack/install` rather than
 * needing a hand-set `SLACK_BOT_TOKEN` per workspace. Every installed
 * workspace's bot token lives in `env.INSTALLATIONS` (KV, via
 * `KVInstallationStore`) and `authorize()` resolves the right one per
 * request — the framework handles URL verification + request-signature
 * verification inside `app.run()`, and OAuth install/callback, the same way.
 *
 * All installed workspaces share the SAME catalog (D1 + Drive) — this bot is
 * for TNL Mediagene's own brand assets across its own workspaces, not a
 * multi-tenant product; OAuth here is self-install convenience, not data
 * isolation between unrelated orgs.
 *
 * Two listeners drive the guided flow:
 *  - `app.message` handles free-text DM replies (brand name, purpose, custom
 *    size);
 *  - `app.action(/^select_/, …)` handles the question buttons
 *    (`response-builder.ts` names every button `select_<field>_<value>`).
 *    Its `ack` returns immediately (required within 3s); the real work runs
 *    in `lazy`, which the framework schedules via `ctx.waitUntil` — matching
 *    how `ctx` is already threaded through for the audit sink below.
 *
 * `ctx` is threaded in so both the delivery audit (D1 write + reviewer-channel
 * notice) and the action's lazy handler run via `ctx.waitUntil(...)`, never
 * delaying or failing the user's turn.
 */
export function createSlackApp(env: Env, ctx?: ExecutionContext): SlackOAuthApp<Env> {
  const app = new SlackOAuthApp({
    env,
    installationStore: new KVInstallationStore(env, env.INSTALLATIONS),
    routes: {
      events: "/slack/events",
      oauth: { start: "/slack/install", callback: "/slack/oauth_redirect" },
    },
  });

  const notifyChannels = parseNotifyChannels(env.AUDIT_NOTIFY_CHANNELS);

  app.message(undefined, async ({ context, payload }) => {
    if (payload.subtype !== undefined) return;
    const text = payload.text?.trim();
    const userId = payload.user;
    const channelId = payload.channel;
    if (!text || !userId || !channelId) return;

    const { deps, repo } = await buildDeps(env);
    const auditSink = createWorkerAuditSink(repo, context.client as any, notifyChannels);
    const ports = buildPorts(
      (msg) => context.say({ ...msg } as any),
      (ab, filename, title) =>
        context.client.files.uploadV2({ channel_id: channelId, file: ab, filename, title }),
      auditSink,
      ctx
    );

    await handleMessage(text, userId, deps, ports);
  });

  // The question buttons `buildQuestionMessage` renders (response-builder.ts)
  // all use action_id `select_<field>_<value>`.
  app.action(
    /^select_/,
    async () => {}, // ack immediately; the real work happens in the lazy handler below.
    async ({ context, payload }) => {
      const userId = payload.user?.id;
      const action = payload.actions?.[0] as { action_id?: string; value?: string } | undefined;
      const actionId = action?.action_id;
      const value = action?.value;
      const channelId = (payload as { channel?: { id?: string } }).channel?.id;
      if (!userId || !actionId || typeof value !== "string" || !channelId) return;

      const { deps, repo } = await buildDeps(env);
      const auditSink = createWorkerAuditSink(repo, context.client as any, notifyChannels);
      const ports = buildPorts(
        (msg) =>
          context.respond
            ? context.respond({ ...msg } as any)
            : context.client.chat.postMessage({ channel: channelId, ...msg } as any),
        (ab, filename, title) =>
          context.client.files.uploadV2({ channel_id: channelId, file: ab, filename, title }),
        auditSink,
        ctx
      );

      await handleBlockAction(userId, actionId, value, deps, ports);
    }
  );

  return app;
}
