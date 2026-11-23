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
  // Multi-workspace OAuth installations (bot token per team), via
  // slack-cloudflare-workers' KVInstallationStore. Separate from
  // CONVERSATIONS: installs persist indefinitely, conversation state doesn't.
  INSTALLATIONS: KVNamespace;
  IMAGES: ImagesBinding; // Cloudflare Images: custom-size render (resize + bg)

  // --- Non-secret vars (wrangler.jsonc [vars]) ---
  MAX_OUTPUT_SIZE: string;
  DRIVE_ROOT_FOLDER_ID: string;
  AUDIT_NOTIFY_CHANNELS: string;
  // OAuth app-installation flow (slack-edge's SlackOAuthEnv shape).
  SLACK_BOT_SCOPES: string;
  SLACK_REDIRECT_URI: string;

  // --- Secrets (wrangler secret put) ---
  // Optional: with OAuth installs, each workspace's bot token comes from
  // INSTALLATIONS instead. Kept optional only as a manual-fallback escape
  // hatch; new/re-installed workspaces never need it set.
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET: string;
  // Not actually secret (visible in the install URL), but set as a secret
  // here rather than a [vars] entry — see wrangler.jsonc.
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  GOOGLE_SERVICE_ACCOUNT_KEY: string;
}
