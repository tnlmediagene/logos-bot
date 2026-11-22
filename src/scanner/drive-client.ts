import { AccessTokenProvider, createGoogleAuth } from "../google-auth";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  modifiedTime: string;
  size: number;
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// Supported by file extension. Drive's mimeType for .svg is unreliable — it is
// often text/xml or application/xml rather than image/svg+xml — so extension is
// the source of truth for what kind of asset a file is.
const SUPPORTED_EXTS = new Set(["svg", "png", "ai", "eps"]);

/** The asset format for a filename, by extension. null = unsupported. */
export function formatForName(name: string): "svg" | "png" | "ai" | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "svg") return "svg";
  if (ext === "png") return "png";
  if (ext === "ai" || ext === "eps") return "ai";
  return null;
}
// Per-request network timeout (ms). Without it a hung connection blocks a whole
// scan forever — a stuck download once idled a scan for over 30 minutes. On
// timeout the fetch aborts, which the scanner catches (dimensions left null).
const REQUEST_TIMEOUT_MS = 30_000;
const SUPPORTED_MIMES = new Set([
  "image/svg+xml",
  "image/png",
  "application/postscript",
  "application/illustrator",
]);

interface DriveFilesListResponse {
  nextPageToken?: string;
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    parents?: string[];
    modifiedTime?: string;
    size?: string;
  }>;
}

/**
 * Pure-`fetch` Google Drive v3 client. Runs on both Node 18+ (offline scan) and
 * Cloudflare Workers (bot delivery) — no `googleapis` SDK, no Node-only
 * dependencies. Authentication is injected as an AccessTokenProvider so the same
 * client works with any token source.
 */
export class DriveClient {
  private readonly auth: AccessTokenProvider;

  /**
   * Accepts either a service-account key JSON string (convenience, builds the
   * provider internally) or a ready AccessTokenProvider (so a Worker can share
   * one cached token source across Drive + Vertex).
   */
  constructor(keyOrProvider: string | AccessTokenProvider) {
    this.auth =
      typeof keyOrProvider === "string"
        ? createGoogleAuth(keyOrProvider, DRIVE_SCOPE)
        : keyOrProvider;
  }

  private async authHeader(): Promise<string> {
    const token = await this.auth.getAccessToken();
    if (!token) throw new Error("Drive authentication failed: no access token was returned.");
    return `Bearer ${token}`;
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { authorization: await this.authHeader(), ...(init?.headers || {}) },
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async listFolder(folderId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, parents, modifiedTime, size)",
        pageSize: "1000",
        // Required for folders that live in a Shared Drive — without these the
        // API silently returns zero results for shared-drive content.
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await this.request(`${DRIVE_API}?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Drive files.list failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as DriveFilesListResponse;

      for (const f of data.files || []) {
        files.push({
          id: f.id!,
          name: f.name!,
          mimeType: f.mimeType!,
          parents: f.parents || [],
          modifiedTime: f.modifiedTime || "",
          size: parseInt(f.size || "0", 10),
        });
      }

      pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    return files;
  }

  /** Download a file's raw bytes by id (used to extract dimensions / render). */
  async downloadFile(fileId: string): Promise<Uint8Array> {
    const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    const res = await this.request(`${DRIVE_API}/${fileId}?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Drive download failed (${res.status}): ${await res.text()}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Public webViewLink for a file, so users can open the original in Drive. */
  async getWebViewLink(fileId: string): Promise<string | null> {
    const params = new URLSearchParams({ fields: "webViewLink", supportsAllDrives: "true" });
    const res = await this.request(`${DRIVE_API}/${fileId}?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Drive files.get failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { webViewLink?: string };
    return data.webViewLink || null;
  }

  isFolder(file: DriveFile): boolean {
    return file.mimeType === FOLDER_MIME;
  }

  isSupported(file: DriveFile): boolean {
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    // Extension first (Drive mislabels .svg as text/xml); mime as a fallback.
    return SUPPORTED_EXTS.has(ext) || SUPPORTED_MIMES.has(file.mimeType);
  }
}
