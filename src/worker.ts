/**
 * logos-bot — Cloudflare Workers entrypoint.
 *
 * Every `/slack/*` path is delegated to `slack-cloudflare-workers`'
 * SlackOAuthApp, which internally dispatches by method + exact path:
 *   - POST /slack/events        — signature + URL-verification challenge,
 *     then `message`/`block_actions` events (parse → KV conversation → D1
 *     resolve → deliver, svg2png-wasm + Cloudflare Images rendering).
 *   - GET  /slack/install        — starts the OAuth install flow.
 *   - GET  /slack/oauth_redirect — OAuth callback; saves the installation
 *     (bot token) to the INSTALLATIONS KV via KVInstallationStore.
 * Anything else under /slack/ (or an unmatched method) gets the library's
 * own 404 — this Worker doesn't need its own fallback for that.
 *
 * The offline `scan` pipeline (src/scan.ts, src/sync/) is untouched — it
 * stays Node-only and talks to D1 via `wrangler d1 execute`/`import`, not
 * through this Worker.
 */

import type { Env } from "./env";
import { createSlackApp } from "./slack-app";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check: confirms the Worker booted and its bindings are present.
    if (url.pathname === "/health" || url.pathname === "/") {
      const bindings = {
        db: typeof env.DB?.prepare === "function",
        conversations: typeof env.CONVERSATIONS?.get === "function",
        installations: typeof env.INSTALLATIONS?.get === "function",
        images: typeof (env.IMAGES as any)?.input === "function",
      };
      return Response.json({
        service: "logos-bot",
        stage: "oauth",
        ok: bindings.db && bindings.conversations && bindings.installations && bindings.images,
        bindings,
      });
    }

    if (url.pathname.startsWith("/slack/")) {
      const app = createSlackApp(env, ctx);
      return await app.run(request, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
