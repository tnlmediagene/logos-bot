import { describe, it, expect } from "vitest";
import { buildComposedSvg, validateDimensions } from "../../src/renderer/worker-renderer";

/**
 * `renderCustomSize`/`renderSvgNatural` themselves call real `svg2png-wasm`,
 * whose `.wasm` import only resolves inside Wrangler's bundler — it fails
 * under plain Node/vitest with "Cannot find package 'wbg'" — so nothing that
 * actually rasterises can run in this suite. `buildComposedSvg` is the pure,
 * WASM-free part (all the positioning/clamping/background logic); these
 * tests cover it directly. The actual pixel output (exact canvas size,
 * padding margin visible, transparent background staying transparent) was
 * verified manually against the real WASM rasteriser via `wrangler dev`
 * --remote, decoding the resulting PNG's real pixels — not by an automated
 * test here.
 */

function attr(svg: string, tag: string, name: string): string | undefined {
  const tagMatch = svg.match(new RegExp(`<${tag}\\b[^>]*>`));
  if (!tagMatch) return undefined;
  const m = tagMatch[0].match(new RegExp(`${name}="([^"]*)"`));
  return m?.[1];
}

describe("validateDimensions (shared)", () => {
  it("accepts valid, rejects zero / oversized / non-integer", () => {
    expect(validateDimensions(500, 500, 4000)).toEqual({ valid: true });
    expect(validateDimensions(0, 500, 4000).valid).toBe(false);
    expect(validateDimensions(5000, 500, 4000).error).toContain("4000");
    expect(validateDimensions(10.5, 500, 4000).error).toContain("整數");
  });
});

describe("buildComposedSvg", () => {
  const pngBytes = new Uint8Array([1, 2, 3, 4]);

  it("sizes the outer canvas to exactly width×height", () => {
    const svg = buildComposedSvg({ pngBytes, width: 1200, height: 630, background: "white" });
    const root = svg.match(/^<svg\b[^>]*>/)![0];
    expect(root).toContain('width="1200"');
    expect(root).toContain('height="630"');
  });

  it("with no padding, the image fills the full canvas (no margin)", () => {
    const svg = buildComposedSvg({ pngBytes, width: 1200, height: 630, background: "white" });
    expect(attr(svg, "image", "x")).toBe("0");
    expect(attr(svg, "image", "y")).toBe("0");
    expect(attr(svg, "image", "width")).toBe("1200");
    expect(attr(svg, "image", "height")).toBe("630");
  });

  it("padding shrinks the image box and centers it, leaving the outer canvas untouched", () => {
    const svg = buildComposedSvg({ pngBytes, width: 1000, height: 1000, background: "white", paddingRatio: 0.2 });
    const root = svg.match(/^<svg\b[^>]*>/)![0];
    // Outer canvas: still the full, unshrunk 1000×1000 — NOT the padded
    // 800×800 box. A prior version re-resized the padded box back up to the
    // full canvas with "contain", which (since the aspect ratios match after
    // uniform shrinking) silently erased the margin entirely.
    expect(root).toContain('width="1000"');
    expect(root).toContain('height="1000"');
    // Inner image: 1000 * (1 - 0.2) = 800, centered with a 100px margin on
    // each side ((1000 - 800) / 2).
    expect(attr(svg, "image", "width")).toBe("800");
    expect(attr(svg, "image", "height")).toBe("800");
    expect(attr(svg, "image", "x")).toBe("100");
    expect(attr(svg, "image", "y")).toBe("100");
  });

  it("clamps an out-of-range padding ratio to <= 0.9 instead of a negative/huge box", () => {
    const svg = buildComposedSvg({ pngBytes, width: 1000, height: 1000, background: "white", paddingRatio: 5 });
    // Clamped to 0.9 → inner box is 1000 * 0.1 = 100.
    expect(attr(svg, "image", "width")).toBe("100");
    expect(attr(svg, "image", "height")).toBe("100");
  });

  it("maps named backgrounds to CSS colors, and omits the rect entirely for transparent", () => {
    expect(buildComposedSvg({ pngBytes, width: 10, height: 10, background: "white" })).toContain('fill="#ffffff"');
    expect(buildComposedSvg({ pngBytes, width: 10, height: 10, background: "black" })).toContain('fill="#000000"');
    const transparent = buildComposedSvg({ pngBytes, width: 10, height: 10, background: "transparent" });
    expect(transparent).not.toContain("<rect");
    const nullBg = buildComposedSvg({ pngBytes, width: 10, height: 10, background: null });
    expect(nullBg).not.toContain("<rect");
  });

  it("passes an arbitrary CSS color through, escaped for the XML attribute", () => {
    const svg = buildComposedSvg({ pngBytes, width: 10, height: 10, background: 'rgb(1,2,3)"onerror' });
    // The literal double-quote must be escaped — an unescaped one would break
    // out of the attribute and corrupt the SVG the WASM rasteriser parses.
    expect(svg).toContain("&quot;onerror");
    expect(svg).not.toContain('"onerror');
  });

  it("embeds the PNG bytes as a base64 data: URI", () => {
    const svg = buildComposedSvg({ pngBytes, width: 10, height: 10, background: "white" });
    const href = attr(svg, "image", "href");
    expect(href).toBe(`data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`);
  });
});
