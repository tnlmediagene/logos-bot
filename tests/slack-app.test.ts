import { afterEach, describe, it, expect, vi } from "vitest";
import { getGoogleAuth, parseAllowedTeamIds, isTeamAllowed, buildAfterInstallationHook } from "../src/slack-app";
import type { Installation } from "slack-cloudflare-workers";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

// Regression coverage for a Copilot PR review finding: OAuth accepted (and
// persisted) an installation from ANY Slack workspace, but every install
// shares the same D1 catalog + Drive service account, so an unapproved
// workspace could read TNL Mediagene's internal brand assets just by
// completing the install flow.
describe("parseAllowedTeamIds / isTeamAllowed", () => {
  it("parses a comma-separated list into a set of trimmed ids", () => {
    const ids = parseAllowedTeamIds("T1, T2 ,T3");
    expect(ids).toEqual(new Set(["T1", "T2", "T3"]));
  });

  it("treats empty/unset as an empty set, not 'allow all'", () => {
    expect(parseAllowedTeamIds(undefined)).toEqual(new Set());
    expect(parseAllowedTeamIds("")).toEqual(new Set());
  });

  it("allows a team only if its id is in the set", () => {
    const allowed = new Set(["T1", "T2"]);
    expect(isTeamAllowed("T1", allowed)).toBe(true);
    expect(isTeamAllowed("T9", allowed)).toBe(false);
    expect(isTeamAllowed(undefined, allowed)).toBe(false);
  });

  it("fails CLOSED when the allowlist is empty — no team is allowed", () => {
    expect(isTeamAllowed("T1", new Set())).toBe(false);
  });
});

function makeInstallation(over: Partial<Installation> = {}): Installation {
  return {
    app_id: "A1",
    user_id: "U1",
    team_id: "T1",
    bot_token: "xoxb-fake-token",
    ...over,
  } as Installation;
}

describe("buildAfterInstallationHook", () => {
  it("lets an approved team's install proceed (returns undefined) without revoking anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hook = buildAfterInstallationHook(new Set(["T1"]));

    const result = await hook({ installation: makeInstallation({ team_id: "T1" }) });

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unapproved team's install with a 403, and revokes the token Slack just issued", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const hook = buildAfterInstallationHook(new Set(["T1"]));

    const result = await hook({ installation: makeInstallation({ team_id: "T-INTRUDER", bot_token: "xoxb-intruder" }) });

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
    // The just-issued token is revoked, not left valid-but-unused.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/auth.revoke",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer xoxb-intruder" }) })
    );
  });

  it("refuses an install with NO team id at all (fail closed), without attempting a revoke", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hook = buildAfterInstallationHook(new Set(["T1"]));

    const result = await hook({ installation: makeInstallation({ team_id: undefined, bot_token: undefined }) });

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses every team when the allowlist is empty — unconfigured means closed, not open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    const hook = buildAfterInstallationHook(new Set());

    const result = await hook({ installation: makeInstallation({ team_id: "T1" }) });

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
  });

  it("does not throw even if the revoke call itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const hook = buildAfterInstallationHook(new Set(["T1"]));

    const result = await hook({ installation: makeInstallation({ team_id: "T-INTRUDER" }) });

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
  });
});
