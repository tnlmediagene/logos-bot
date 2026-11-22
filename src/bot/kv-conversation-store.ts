import { ConversationState } from "./conversation";

/** Conversation TTL in KV: a half-finished flow expires after 30 min idle. */
const CONVERSATION_TTL_SECONDS = 30 * 60;

/**
 * KV-backed conversation store for the Worker.
 *
 * The Node bot kept in-flight conversations in a process-memory Map
 * (`ConversationStore`), but a Worker is stateless per request — a Map would be
 * empty on the next event. This stores each user's state as a JSON value in the
 * `CONVERSATIONS` KV namespace, keyed by Slack user id, with a TTL so an
 * abandoned multi-turn flow cleans itself up (replacing the old in-memory
 * volatility with an explicit expiry).
 *
 * The interface mirrors `ConversationStore` but is async (KV is a Promise API).
 */
export class KvConversationStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(userId: string): Promise<ConversationState | undefined> {
    const state = await this.kv.get<ConversationState>(userId, "json");
    return state ?? undefined;
  }

  async set(userId: string, state: ConversationState): Promise<void> {
    await this.kv.put(userId, JSON.stringify(state), {
      expirationTtl: CONVERSATION_TTL_SECONDS,
    });
  }

  async delete(userId: string): Promise<void> {
    await this.kv.delete(userId);
  }
}
