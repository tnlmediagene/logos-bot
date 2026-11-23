import { ConversationState } from "./conversation";

/** Conversation TTL in KV: a half-finished flow expires after 30 min idle. */
const CONVERSATION_TTL_SECONDS = 30 * 60;

/**
 * KV-backed conversation store for the Worker.
 *
 * The Node bot kept in-flight conversations in a process-memory Map
 * (`ConversationStore`), but a Worker is stateless per request — a Map would be
 * empty on the next event. This stores each user's state as a JSON value in the
 * `CONVERSATIONS` KV namespace, with a TTL so an abandoned multi-turn flow
 * cleans itself up (replacing the old in-memory volatility with an explicit
 * expiry).
 *
 * `key` is a full lookup key, not a bare Slack user id: with multi-workspace
 * OAuth installs sharing this one namespace, a plain user id isn't unique —
 * Slack mints ids independently per workspace, so two different teams can
 * mint the same literal id, and even within one team the same person can
 * have more than one conversation surface with the bot open at once (their
 * 1:1 DM plus a group DM they share with it, for example). Callers
 * (`worker-message-handler.ts`'s `conversationKey()`) scope the key by team
 * AND channel before calling in, so none of those can read or overwrite
 * another's in-progress conversation.
 *
 * The interface mirrors `ConversationStore` but is async (KV is a Promise API).
 */
export class KvConversationStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string): Promise<ConversationState | undefined> {
    const state = await this.kv.get<ConversationState>(key, "json");
    return state ?? undefined;
  }

  async set(key: string, state: ConversationState): Promise<void> {
    await this.kv.put(key, JSON.stringify(state), {
      expirationTtl: CONVERSATION_TTL_SECONDS,
    });
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
