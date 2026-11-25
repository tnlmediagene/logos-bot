import "dotenv/config";
import { readFileSync } from "fs";

/**
 * Resolve the Google service account key from either a file path
 * (GOOGLE_SERVICE_ACCOUNT_KEY_PATH — preferred, keeps the secret out of .env
 * and out of git) or an inline JSON string (GOOGLE_SERVICE_ACCOUNT_KEY).
 */
export function resolveServiceAccountKey(
  env: NodeJS.ProcessEnv = process.env
): string {
  const path = env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (path) {
    return readFileSync(path, "utf-8");
  }
  const inline = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (inline) {
    return inline;
  }
  throw new Error(
    "Missing Google credentials: set GOOGLE_SERVICE_ACCOUNT_KEY_PATH (path to the service account JSON file) or GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON)."
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * Config for the offline `scan` pipeline only (the live bot runs as a Worker
 * and reads its own env via wrangler, not this file — see src/env.ts). Lazy
 * getters so a command only needing a subset of the environment doesn't throw
 * on unrelated missing vars at import time.
 *
 * Slack tokens, AUDIT_NOTIFY_CHANNELS, MAX_OUTPUT_SIZE, and an AI-provider key
 * used to live here too, back when a Node/Bolt process also ran the live bot.
 * They're gone with that code (the Worker is the only thing reading them now).
 */
export const config = {
  get GOOGLE_SERVICE_ACCOUNT_KEY(): string {
    return resolveServiceAccountKey();
  },
  get DRIVE_ROOT_FOLDER_ID(): string {
    return requireEnv("DRIVE_ROOT_FOLDER_ID");
  },
  get DATABASE_PATH(): string {
    return process.env.DATABASE_PATH || "./data/catalog.db";
  },
};
