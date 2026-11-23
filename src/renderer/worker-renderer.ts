import { initialize, svg2png } from "svg2png-wasm";
import { validateDimensions } from "./validate-dimensions";

/**
 * Cloudflare Images binding surface we rely on (subset of ImagesBinding). Typed
 * locally so the module compiles without the full @cloudflare/workers-types
 * Images types, and so the dependency on Images is explicit and narrow.
 *
 * `transform()` and `draw()` both return the same chainable shape (matching
 * the real `ImageTransformer`), so either can be followed by more `draw()`
 * calls or a final `output()`.
 */
export interface ImageTransformerLike {
  transform(opts: {
    width?: number;
    height?: number;
    fit?: "scale-down" | "contain" | "pad" | "squeeze" | "cover" | "crop";
    background?: string;
  }): ImageTransformerLike;
  /** Draw `image` onto this one. Omitting all of top/left/bottom/right centers it. */
  draw(
    image: ImageTransformerLike,
    opts?: { opacity?: number; top?: number; left?: number; bottom?: number; right?: number }
  ): ImageTransformerLike;
  output(opts: { format: string; background?: string }): Promise<{
    response(): Response;
    image(): ReadableStream;
  }>;
}

export interface ImagesBindingLike {
  input(stream: ReadableStream | ArrayBuffer | Uint8Array): ImageTransformerLike;
}

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
    // graph stays importable under Node/vitest for the CF-Images-only paths;
    // the WASM only resolves when the SVG rasteriser actually runs. On Workers,
    // Wrangler bundles this dynamic import as a WebAssembly.Module (Workers
    // forbids dynamic WebAssembly.instantiate() of raw bytes, but a module
    // import is allowed). A failed init clears the cache so a later request
    // can retry.
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

// A 1×1 fully-transparent PNG (68 bytes), used as the base for an exact-size
// background canvas (see renderCustomSize). A static constant rather than a
// svg2png-wasm rasterisation: it needs no WASM init, so a PNG-source
// custom-size render never pays for or depends on the SVG rasteriser, and
// it's trivially inspectable (decodes to a real 1×1 RGBA PNG — verified with
// `file`/zlib at the time this was generated, not hand-typed).
const BLANK_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

function blankPixel(): Uint8Array {
  const binary = atob(BLANK_PIXEL_PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Render a source to an exact width×height canvas with the logo scaled to fit
 * (preserving aspect ratio), centred, and the requested background filled.
 *
 * SVG source → rasterised by svg2png-wasm first. `paddingRatio` shrinks the
 * fit box so the logo occupies (1 - ratio) of the canvas with equal margin,
 * reproducing the old sharp-composite behaviour (0 = edge-to-edge).
 *
 * Two Images operations, composited rather than chained as two resizes:
 *  1. The logo is `fit: "contain"`-scaled into the (possibly shrunk) inner
 *     box, preserving its own aspect ratio — this is the ONLY resize of the
 *     logo's content, so a deliberate margin (paddingRatio > 0) is never
 *     scaled away by a later step.
 *  2. A blank 1×1 pixel is `fit: "pad"`-expanded to the exact outer
 *     width×height, filled with `background` — `fit: "pad"` is required
 *     here (not `"contain"`), because `"contain"` only guarantees the
 *     content FITS within the box and can return a canvas smaller than
 *     width×height on one axis when the aspect ratios differ; only `"pad"`
 *     (and a few other fit modes) guarantee the output canvas is exactly
 *     the requested size (confirmed against Cloudflare's fit-mode docs).
 * The logo is then `.draw()`n onto that base — omitting every position
 * option centers it automatically, so there is no manual offset math.
 */
export async function renderCustomSize(
  req: WorkerRenderRequest,
  images: ImagesBindingLike
): Promise<WorkerRenderResult> {
  const { source, sourceFormat, width, height, background } = req;

  // Rasterise SVG → PNG bytes first; a PNG source is used as-is.
  let pngBytes: Uint8Array;
  if (sourceFormat === "svg") {
    await ensureWasm();
    const svgText = new TextDecoder().decode(source);
    // Rasterise at 2× the target width for crisp downscaling in Images.
    pngBytes = await svg2png(svgText, { width: width * 2 });
  } else {
    pngBytes = source;
  }

  const p = Math.min(Math.max(req.paddingRatio ?? 0, 0), 0.9);
  const bg = backgroundColor(background);
  const innerW = Math.round(width * (1 - p));
  const innerH = Math.round(height * (1 - p));

  const inner = images
    .input(toArrayBuffer(pngBytes))
    .transform({ width: innerW, height: innerH, fit: "contain" });
  const base = images
    .input(toArrayBuffer(blankPixel()))
    .transform({ width, height, fit: "pad", background: bg });

  const out = await base.draw(inner, {}).output({ format: "image/png" });
  const bytes = new Uint8Array(await out.response().arrayBuffer());
  return { bytes, actualWidth: width, actualHeight: height };
}

/** Copy a Uint8Array into a fresh, exactly-sized ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

/** Read width/height from a PNG's IHDR chunk (bytes 16..24). */
function readPngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export { validateDimensions };
