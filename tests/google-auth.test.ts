import { afterEach, describe, it, expect, vi } from "vitest";
import { createGoogleAuth } from "../src/google-auth";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Generate an RSA keypair and return the private key as PKCS#8 PEM. */
async function makeServiceAccountKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let b64 = "";
  for (const b of pkcs8) b64 += String.fromCharCode(b);
  b64 = btoa(b64);
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("createGoogleAuth", () => {
  it("signs a verifiable RS256 JWT and exchanges it for an access token", async () => {
    const { pem, publicKey } = await makeServiceAccountKey();
    const keyJson = JSON.stringify({ client_email: "svc@p.iam.gserviceaccount.com", private_key: pem });

    let capturedAssertion = "";
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      capturedAssertion = new URLSearchParams(init.body).get("assertion") || "";
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-123", expires_in: 3600 }), text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = createGoogleAuth(keyJson, SCOPE);
    const token = await auth.getAccessToken();

    expect(token).toBe("tok-123");

    // The assertion is a well-formed JWT whose signature verifies with the public key.
    const [h, p, sig] = capturedAssertion.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe("svc@p.iam.gserviceaccount.com");
    expect(claims.scope).toBe(SCOPE);
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");

    const ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${p}`)
    );
    expect(ok).toBe(true);
  });

  it("caches the token and does not re-mint before expiry", async () => {
    const { pem } = await makeServiceAccountKey();
    const keyJson = JSON.stringify({ client_email: "svc@p.iam.gserviceaccount.com", private_key: pem });

    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ access_token: "tok-abc", expires_in: 3600 }), text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const auth = createGoogleAuth(keyJson, SCOPE);
    const a = await auth.getAccessToken();
    const b = await auth.getAccessToken();

    expect(a).toBe("tok-abc");
    expect(b).toBe("tok-abc");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws a clear error when the token endpoint rejects the assertion", async () => {
    const { pem } = await makeServiceAccountKey();
    const keyJson = JSON.stringify({ client_email: "svc@p.iam.gserviceaccount.com", private_key: pem });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({}), text: async () => "invalid_grant",
    })));

    const auth = createGoogleAuth(keyJson, SCOPE);
    await expect(auth.getAccessToken()).rejects.toThrow(/token exchange failed.*401/i);
  });

  it("rejects a malformed service-account key only when a token is requested", async () => {
    const auth = createGoogleAuth("{}", SCOPE); // construction must not throw
    await expect(auth.getAccessToken()).rejects.toThrow(/client_email or private_key/i);
  });
});
