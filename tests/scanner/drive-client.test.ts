import { afterEach, describe, it, expect, vi } from "vitest";
import { DriveClient, formatForName } from "../../src/scanner/drive-client";

// An injectable token provider so no real auth/network happens; fetch is stubbed.
const tokenProvider = { getAccessToken: async () => "drive-access-token" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub global fetch with a queue of JSON responses (one per call). */
function stubFetchJson(responses: any[]) {
  let call = 0;
  const fn = vi.fn(async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("format / support by extension (Drive mislabels .svg)", () => {
  const client = new DriveClient(tokenProvider);
  const f = (name: string, mimeType: string) => ({ id: "1", name, mimeType, parents: [], modifiedTime: "", size: 0 });

  it("treats a .svg stored as text/xml as a supported svg", () => {
    // This is exactly what broke TNL / iCook: Drive typed their .svg as text/xml.
    expect(client.isSupported(f("logo-primary.svg", "text/xml"))).toBe(true);
    expect(formatForName("logo-primary.svg")).toBe("svg");
  });

  it("still supports correctly-typed files and rejects unsupported ones", () => {
    expect(client.isSupported(f("a.png", "image/png"))).toBe(true);
    expect(client.isSupported(f("a.ai", "application/illustrator"))).toBe(true);
    expect(client.isSupported(f("notes.txt", "text/plain"))).toBe(false);
    expect(formatForName("logo.ai")).toBe("ai");
    expect(formatForName("readme.md")).toBeNull();
  });
});

describe("DriveClient.listFolder", () => {
  it("passes shared-drive params so Shared Drive contents are returned", async () => {
    const fetchMock = stubFetchJson([{ files: [], nextPageToken: undefined }]);
    const client = new DriveClient(tokenProvider);

    await client.listFolder("folder-1");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("supportsAllDrives=true");
    expect(url).toContain("includeItemsFromAllDrives=true");
    // Auth header carries the injected token.
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.headers.authorization).toBe("Bearer drive-access-token");
  });

  it("maps returned files and follows pagination", async () => {
    const fetchMock = stubFetchJson([
      {
        files: [
          { id: "a", name: "logo.svg", mimeType: "image/svg+xml", parents: ["folder-1"], modifiedTime: "t", size: "10" },
        ],
        nextPageToken: "next",
      },
      {
        files: [
          { id: "b", name: "mark.png", mimeType: "image/png", parents: ["folder-1"], modifiedTime: "t", size: "20" },
        ],
        nextPageToken: undefined,
      },
    ]);
    const client = new DriveClient(tokenProvider);

    const files = await client.listFolder("folder-1");

    expect(files.map((f) => f.id)).toEqual(["a", "b"]);
    expect(files[0].size).toBe(10);
    // Second page followed via pageToken.
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=next");
  });
});

describe("DriveClient.downloadFile", () => {
  it("returns the raw bytes as a Uint8Array", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fn);
    const client = new DriveClient(tokenProvider);

    const out = await client.downloadFile("file-1");

    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(String(fn.mock.calls[0][0])).toContain("alt=media");
  });
});
