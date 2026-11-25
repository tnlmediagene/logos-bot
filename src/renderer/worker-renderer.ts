import { initialize, svg2png } from "svg2png-wasm";
import { validateDimensions } from "./validate-dimensions";

export interface WorkerRenderRequest {
  /** Raw source bytes (SVG text bytes or PNG bytes). */
  source: Uint8Array;
  sourceFormat: "svg" | "png";
  width: number;
  height: number;
  background: "transparent" | "white" | "black" | string;
  /** Fraction of the canvas reserved as margin around the logo (0–0.9). */
  paddingRatio?: number;
}

export interface WorkerRenderResult {
  bytes: Uint8Array;
  actualWidth: number;
  actualHeight: number;
}

// --- svg2png-wasm one-time init (idempotent across requests in one isolate) ---
let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    // The .wasm is imported DYNAMICALLY (not at module top level) so the module
    // graph stays importable under Node/vitest; the WASM only resolves when
    // the rasteriser actually runs. On Workers, Wrangler bundles this dynamic
    // import as a WebAssembly.Module (Workers forbids dynamic
    // WebAssembly.instantiate() of raw bytes, but a module import is
    // allowed). A failed init clears the cache so a later request can retry.
    wasmReady = (async () => {
      const mod = (await import("svg2png-wasm/svg2png_wasm_bg.wasm")).default;
      await initialize(mod as WebAssembly.Module);
    })().catch((err) => {
      wasmReady = null;
      throw err;
    });
  }
  return wasmReady;
}

/** CSS color for a named background; null/transparent → no fill. */
function backgroundColor(bg: string | null | undefined): string | undefined {
  if (!bg || bg === "transparent") return undefined;
  if (bg === "white") return "#ffffff";
  if (bg === "black") return "#000000";
  return bg; // already a CSS color
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Rasterise an SVG to a PNG at its own natural size (svg2png reads the size from
 * the SVG's width/height/viewBox). Transparent background. The Workers
 * equivalent of renderSvgNatural() — returns Uint8Array, not Buffer.
 */
export async function renderSvgNatural(source: Uint8Array): Promise<WorkerRenderResult> {
  await ensureWasm();
  const svgText = new TextDecoder().decode(source);
  const bytes = await svg2png(svgText, {});
  const dims = readPngDimensions(bytes);
  return { bytes, actualWidth: dims.width, actualHeight: dims.height };
}

export interface ComposedSvgParams {
  /** PNG bytes to embed (the logo content, already rasterised if it came from SVG). */
  pngBytes: Uint8Array;
  width: number;
  height: number;
  background: string | null | undefined;
  /** Fraction of the canvas reserved as margin around the logo (0–0.9). */
  paddingRatio?: number;
}

/**
 * Build the wrapper SVG `renderCustomSize` rasterises: a `background`-filled
 * `<rect>`, then an `<image>` embedding `pngBytes` as a base64 `data:` URI,
 * sized to the (possibly padding-shrunk) inner box with
 * `preserveAspectRatio="xMidYMid meet"` (SVG's own "contain, centered" — the
 * default, spelled out here for clarity).
 *
 * Pure string-building, no WASM — split out from `renderCustomSize` so the
 * positioning/clamping/background math is unit-testable directly.
 * `svg2png-wasm`'s `.wasm` import only resolves inside Wrangler's bundler
 * (confirmed: it fails under plain Node/vitest with "Cannot find package
 * 'wbg'"), so nothing that actually calls `svg2png()` can run in the normal
 * test suite — real rasterisation here is verified manually via
 * `wrangler dev`/`--remote`, not by an automated test.
 */
export function buildComposedSvg(params: ComposedSvgParams): string {
  const { pngBytes, width, height, background } = params;
  const p = Math.min(Math.max(params.paddingRatio ?? 0, 0), 0.9);
  const innerW = Math.round(width * (1 - p));
  const innerH = Math.round(height * (1 - p));
  const offsetX = Math.round((width - innerW) / 2);
  const offsetY = Math.round((height - innerH) / 2);

  const bg = backgroundColor(background);
  const bgRect = bg ? `<rect width="${width}" height="${height}" fill="${escapeXmlAttr(bg)}"/>` : "";
  const b64 = bytesToBase64(pngBytes);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    bgRect +
    `<image x="${offsetX}" y="${offsetY}" width="${innerW}" height="${innerH}" ` +
    `preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${b64}"/>` +
    `</svg>`
  );
}

/**
 * Render a source to an exact width×height canvas with the logo scaled to fit
 * (preserving aspect ratio), centred, and the requested background filled.
 *
 * Pure svg2png-wasm — no Cloudflare Images binding. The source is rasterised
 * to PNG first if it was an SVG, then embedded via `buildComposedSvg` (an
 * `<image>`, regardless of the original source format) and rasterised ONE
 * more time to the exact requested canvas. SVG's own fit semantics never
 * have the "does the output canvas actually match the request" ambiguity
 * that motivated switching an earlier, Cloudflare-Images-based version of
 * this function from `fit:"contain"` to `fit:"pad"` (see git history), so
 * there's nothing to get subtly wrong by composing instead of calling a
 * resize API.
 */
export async function renderCustomSize(req: WorkerRenderRequest): Promise<WorkerRenderResult> {
  const { source, sourceFormat, width, height, background } = req;
  await ensureWasm();

  // Rasterise SVG → PNG bytes first; a PNG source is used as-is. Either way,
  // the result is embedded as an <image>, so both source formats go through
  // the exact same composition + final-rasterise step.
  let pngBytes: Uint8Array;
  if (sourceFormat === "svg") {
    const svgText = new TextDecoder().decode(source);
    // Rasterise at 2× the larger target dimension for a crisp downscale.
    pngBytes = await svg2png(svgText, { width: Math.max(width, height) * 2 });
  } else {
    pngBytes = source;
  }

  const composed = buildComposedSvg({ pngBytes, width, height, background, paddingRatio: req.paddingRatio });
  const bytes = await svg2png(composed, {});
  return { bytes, actualWidth: width, actualHeight: height };
}

/** Read width/height from a PNG's IHDR chunk (bytes 16..24). */
function readPngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export { validateDimensions };
