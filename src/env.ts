/**
 * Worker environment: bindings, vars, and secrets.
 *
 * Bindings (D1, KV, Images) are declared in wrangler.jsonc.
 * `[vars]` are non-secret config, also in wrangler.jsonc.
 * Secrets are injected via `wrangler secret put` and listed here for typing.
 *
 * Cloudflare's own types (D1Database, KVNamespace, ExecutionContext, …) come
 * from @cloudflare/workers-types (added to devDependencies in the scaffold).
 */
export interface Env {
  // --- Bindings ---
  DB: D1Database;
  CONVERSATIONS: KVNamespace;
  IMAGES: ImagesBinding; // Cloudflare Images: custom-size render (resize + bg)

  // --- Non-secret vars (wrangler.jsonc [vars]) ---
  AI_PROVIDER: string;
  GEMINI_MODEL: string;
  MAX_OUTPUT_SIZE: string;
  DRIVE_ROOT_FOLDER_ID: string;
  VERTEX_PROJECT_ID: string;
  VERTEX_LOCATION: string;
  AUDIT_NOTIFY_CHANNELS: string;

  // --- Secrets (wrangler secret put) ---
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  GOOGLE_SERVICE_ACCOUNT_KEY: string;
}
