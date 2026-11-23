import { describe, it, expect } from "vitest";
import { renderCustomSize, validateDimensions, ImagesBindingLike } from "../../src/renderer/worker-renderer";

/**
 * Fake Cloudflare Images binding that records every transform() opts object and
 * returns stub PNG bytes. Lets us assert the exact canvas/fit/background the
 * renderer asks Images for, without the real binding (which only exists inside
 * the Workers runtime — the WASM SVG rasteriser is exercised under wrangler dev).
 */
function fakeImages(): ImagesBindingLike & { calls: any[]; draws: any[]; outBytes: Uint8Array } {
  const calls: any[] = [];
  const draws: any[] = [];
  const outBytes = new Uint8Array([7, 7, 7, 7]);
  function node(): any {
    return {
      transform(opts: any) {
        calls.push(opts);
        return node();
      },
      draw(image: any, opts: any) {
        draws.push({ image, opts });
        return node();
      },
      output() {
        return Promise.resolve({
          response: () => new Response(outBytes),
          image: () => new Response(outBytes).body!,
        });
      },
    };
  }
  return {
    calls,
    draws,
    outBytes,
    input() {
      return node();
    },
  } as any;
}

describe("validateDimensions (shared)", () => {
  it("accepts valid, rejects zero / oversized / non-integer", () => {
    expect(validateDimensions(500, 500, 4000)).toEqual({ valid: true });
    expect(validateDimensions(0, 500, 4000).valid).toBe(false);
    expect(validateDimensions(5000, 500, 4000).error).toContain("4000");
    expect(validateDimensions(10.5, 500, 4000).error).toContain("整數");
  });
});

describe("renderCustomSize (PNG source → Images)", () => {
  it("builds an exact-size background canvas and draws the logo onto it, centered", async () => {
    const images = fakeImages();
    const src = new Uint8Array([1, 2, 3, 4]);
    const result = await renderCustomSize(
      { source: src, sourceFormat: "png", width: 1200, height: 630, background: "transparent" },
      images
    );
    expect(result.actualWidth).toBe(1200);
    expect(result.actualHeight).toBe(630);
    expect(Array.from(result.bytes)).toEqual([7, 7, 7, 7]);
    // Two transforms: the logo fit into the (unshrunk, p=0) box, and the
    // base canvas padded to the exact outer size — NOT the same "contain"
    // call reused for both, which is what silently produced an
    // under-sized canvas when the source aspect ratio didn't match.
    expect(images.calls).toHaveLength(2);
    expect(images.calls[0]).toMatchObject({ width: 1200, height: 630, fit: "contain" });
    expect(images.calls[0].background).toBeUndefined();
    expect(images.calls[1]).toMatchObject({ width: 1200, height: 630, fit: "pad" });
    // The base canvas must guarantee the exact size, hence "pad" not "contain".
    expect(images.calls[1].background).toBeUndefined();
    // The logo is drawn onto the base with no position options → centered.
    expect(images.draws).toHaveLength(1);
    expect(images.draws[0].opts).toEqual({});
  });

  it("maps named backgrounds to CSS colors on the base canvas", async () => {
    const images = fakeImages();
    await renderCustomSize(
      { source: new Uint8Array([1]), sourceFormat: "png", width: 100, height: 100, background: "white" },
      images
    );
    expect(images.calls[1].background).toBe("#ffffff");

    const images2 = fakeImages();
    await renderCustomSize(
      { source: new Uint8Array([1]), sourceFormat: "png", width: 100, height: 100, background: "black" },
      images2
    );
    expect(images2.calls[1].background).toBe("#000000");
  });

  it("padding shrinks only the logo's fit box, never the outer canvas", async () => {
    const images = fakeImages();
    await renderCustomSize(
      { source: new Uint8Array([1]), sourceFormat: "png", width: 1000, height: 1000, background: "white", paddingRatio: 0.2 },
      images
    );
    // Logo fit into the shrunk (1-0.2)=800 inner box...
    expect(images.calls[0]).toMatchObject({ width: 800, height: 800, fit: "contain" });
    expect(images.calls[0].background).toBeUndefined();
    // ...but the base canvas (what actually determines the output size) is
    // still the full, unshrunk 1000×1000 — this is the bug Copilot caught:
    // a prior version re-resized the already-padded 800×800 result back up
    // to 1000×1000 with "contain", which (since the aspect ratios match)
    // scaled the logo to fill the canvas and erased the padding entirely.
    expect(images.calls[1]).toMatchObject({ width: 1000, height: 1000, fit: "pad", background: "#ffffff" });
    // The (smaller, padded) logo is drawn onto the full-size base, centered.
    expect(images.draws).toHaveLength(1);
    expect(images.draws[0].opts).toEqual({});
  });

  it("clamps an out-of-range padding ratio to <= 0.9", async () => {
    const images = fakeImages();
    await renderCustomSize(
      { source: new Uint8Array([1]), sourceFormat: "png", width: 1000, height: 1000, background: "transparent", paddingRatio: 5 },
      images
    );
    // Clamped to 0.9 → inner box 100, not a negative/huge value.
    expect(images.calls[0]).toMatchObject({ width: 100, height: 100 });
  });
});
