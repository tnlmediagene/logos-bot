import { describe, it, expect } from "vitest";
import { getGoogleAuth } from "../src/slack-app";

// Regression coverage for a round-2 Copilot review finding: `buildDeps` used
// to call `createGoogleAuth(...)` fresh on every single inbound Slack
// message/action, discarding that provider's in-memory token cache
// (google-auth.ts) every time — so every request re-minted a brand new
// Google OAuth access token instead of reusing a still-valid one. The fix is
// `getGoogleAuth`, a module-level cache keyed by (scope, key) that `buildDeps`
// now calls instead of `createGoogleAuth` directly.
describe("getGoogleAuth", () => {
  it("returns the SAME provider instance for the same scope + key across calls", () => {
    const a = getGoogleAuth("key-1", "scope-a");
    const b = getGoogleAuth("key-1", "scope-a");
    expect(a).toBe(b);
  });

  it("returns a DIFFERENT provider instance for a different scope", () => {
    const a = getGoogleAuth("key-1", "scope-a");
    const b = getGoogleAuth("key-1", "scope-b");
    expect(a).not.toBe(b);
  });

  it("returns a DIFFERENT provider instance for a different key", () => {
    const a = getGoogleAuth("key-1", "scope-a");
    const b = getGoogleAuth("key-2", "scope-a");
    expect(a).not.toBe(b);
  });
});
