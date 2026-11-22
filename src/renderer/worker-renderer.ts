import { initialize, svg2png } from "svg2png-wasm";
import { validateDimensions } from "./validate-dimensions";

/**
 * Cloudflare Images binding surface we rely on (subset of ImagesBinding). Typed
 * locally so the module compiles without the full @cloudflare/workers-types
 * Images types, and so the dependency on Images is explicit and narrow.
 */
export interface ImagesBindingLike {
  input(stream: ReadableStream | ArrayBuffer | Uint8Array): {
    transform(opts: {
      width?: number;
      height?: number;
      fit?: "scale-down" | "contain" | "cover" | "crop" | "pad";
      background?: string;
    }): {
      output(opts: { format: string; background?: string }): Promise<{
        response(): Response;
        image(): ReadableStream;
      }>;
    };
  };
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

/**
 * Render a source to an exact width×height canvas with the logo scaled to fit
 * (preserving aspect ratio), centred, and the requested background filled.
 *
 * SVG source → rasterised by svg2png-wasm first. The exact-canvas resize +
 * contain + centre + background is done by the Cloudflare Images binding
 * (`fit: "contain"` centres and pads to the exact canvas, matching the old
 * sharp composite). `paddingRatio` shrinks the fit box so the logo occupies
 * (1 - ratio) of the canvas with equal margin, reproducing the sharp behaviour.
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

  // Shrink the fit box by the padding ratio: the logo occupies (1 - p) of the
  // canvas, leaving equal margin on all sides. Images `fit: "contain"` centres
  // the scaled image on the exact width×height canvas and fills the rest with
  // `background`.
  const p = Math.min(Math.max(req.paddingRatio ?? 0, 0), 0.9);
  const bg = backgroundColor(background);

  if (p > 0) {
    // Two-step: resize into the inner (1-p) box, then pad to the exact canvas.
    const innerW = Math.round(width * (1 - p));
    const innerH = Math.round(height * (1 - p));
    const inner = await images
      .input(toArrayBuffer(pngBytes))
      .transform({ width: innerW, height: innerH, fit: "contain", background: bg })
      .output({ format: "image/png" });
    const innerBytes = new Uint8Array(await inner.response().arrayBuffer());
    const out = await images
      .input(toArrayBuffer(innerBytes))
      .transform({ width, height, fit: "contain", background: bg })
      .output({ format: "image/png" });
    const bytes = new Uint8Array(await out.response().arrayBuffer());
    return { bytes, actualWidth: width, actualHeight: height };
  }

  const out = await images
    .input(toArrayBuffer(pngBytes))
    .transform({ width, height, fit: "contain", background: bg })
    .output({ format: "image/png" });
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
