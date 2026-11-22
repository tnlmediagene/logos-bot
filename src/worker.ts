/**
 * logos-bot — Cloudflare Workers entrypoint.
 *
 * `/slack/events` is delegated to `slack-cloudflare-workers`' SlackApp, which
 * verifies the request signature, answers Slack's URL-verification challenge,
 * and dispatches `message` events to the full pipeline (parse → KV conversation
 * → D1 resolve → deliver, with svg2png-wasm + Cloudflare Images rendering).
 *
 * The existing Node entrypoint (src/index.ts) and the offline `scan` pipeline
 * are left untouched during the migration so current tests stay green.
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
        images: typeof (env.IMAGES as any)?.input === "function",
      };
      return Response.json({
        service: "logos-bot",
        stage: "render",
        ok: bindings.db && bindings.conversations,
        bindings,
      });
    }

    // Slack Events API: signature + URL verification + event dispatch are all
    // handled inside app.run().
    if (url.pathname === "/slack/events") {
      const app = createSlackApp(env, ctx);
      return await app.run(request, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
