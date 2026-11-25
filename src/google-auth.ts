/**
 * Google service-account authentication using only WebCrypto + fetch, so the
 * same code runs on both Node 18+ (offline scan) and Cloudflare Workers (the
 * bot). This replaces `googleapis`' `google.auth.GoogleAuth`, which depends on
 * Node-only internals that Workers cannot load.
 *
 * Flow: build a signed JWT (RS256) from the service-account key, POST it to
 * Google's token endpoint, receive a short-lived OAuth access token. Tokens are
 * cached in memory per scope until shortly before expiry.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// Google access tokens last ~3600s. Refresh a minute early to avoid races where
// a token expires mid-request.
const EXPIRY_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 3600;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string | null>;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch seconds
}

/**
 * Build an access-token provider for one OAuth scope from a service-account key
 * (the JSON string stored in a secret / env var). The returned provider caches
 * the token in memory and re-signs only when it is near expiry.
 */
export function createGoogleAuth(serviceAccountKey: string, scope: string): AccessTokenProvider {
  let key: ServiceAccountKey | null = null;
  let cached: CachedToken | null = null;

  return {
    async getAccessToken(): Promise<string | null> {
      const now = Math.floor(Date.now() / 1000);
      if (cached && cached.expiresAt - EXPIRY_SKEW_SECONDS > now) {
        return cached.token;
      }
      // Parse lazily: a provider can be constructed with a placeholder key and
      // only fail when a token is actually needed (matches the old SDK behavior).
      if (!key) key = parseServiceAccountKey(serviceAccountKey);
      const token = await mintAccessToken(key, scope, now);
      cached = { token: token.access_token, expiresAt: now + token.expires_in };
      return token.access_token;
    },
  };
}

function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.");
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("Service account key is missing client_email or private_key.");
  }
  return key;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

async function mintAccessToken(
  key: ServiceAccountKey,
  scope: string,
  now: number
): Promise<TokenResponse> {
  const assertion = await signJwt(key, scope, now);
  const res = await fetch(key.token_uri || TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as Partial<TokenResponse>;
  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new Error("Google token endpoint returned no access_token.");
  }
  return { access_token: data.access_token, expires_in: data.expires_in };
}

/** Build and RS256-sign the service-account JWT assertion. */
async function signJwt(key: ServiceAccountKey, scope: string, now: number): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: key.client_email,
    scope,
    aud: key.token_uri || TOKEN_ENDPOINT,
    iat: now,
    exp: now + JWT_LIFETIME_SECONDS,
  };

  const encodedHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaims = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  const cryptoKey = await importPrivateKey(key.private_key);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    toArrayBuffer(new TextEncoder().encode(signingInput))
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Import a PEM PKCS#8 private key for RS256 signing via WebCrypto. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(body);
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * Copy bytes into a fresh plain ArrayBuffer. WebCrypto's BufferSource type
 * rejects a Uint8Array whose backing buffer could be a SharedArrayBuffer (the
 * Node DOM lib widens `.buffer` to ArrayBufferLike); a fresh ArrayBuffer pins
 * the type and is correct on both Node and Workers.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
