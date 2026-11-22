import { describe, it, expect } from "vitest";
import { renderCustomSize, validateDimensions, ImagesBindingLike } from "../../src/renderer/worker-renderer";

/**
 * Fake Cloudflare Images binding that records every transform() opts object and
 * returns stub PNG bytes. Lets us assert the exact canvas/fit/background the
 * renderer asks Images for, without the real binding (which only exists inside
 * the Workers runtime — the WASM SVG rasteriser is exercised under wrangler dev).
 */
function fakeImages(): ImagesBindingLike & { calls: any[]; outBytes: Uint8Array } {
  const calls: any[] = [];
  const outBytes = new Uint8Array([7, 7, 7, 7]);
  return {
    calls,
    outBytes,
    input() {
      return {
        transform(opts: any) {
          calls.push(opts);
          return {
            output() {
              return Promise.resolve({
                response: () => new Response(outBytes),
                image: () => new Response(outBytes).body!,
              });
            },
          };
        },
      };
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
  it("resizes a PNG to the exact canvas with contain + transparent bg", async () => {
    const images = fakeImages();
    const src = new Uint8Array([1, 2, 3, 4]);
    const result = await renderCustomSize(
      { source: src, sourceFormat: "png", width: 1200, height: 630, background: "transparent" },
      images
    );
    expect(result.actualWidth).toBe(1200);
    expect(result.actualHeight).toBe(630);
    expect(Array.from(result.bytes)).toEqual([7, 7, 7, 7]);
    // One transform call at the exact canvas; transparent → no background fill.
    expect(images.calls).toHaveLength(1);
    expect(images.calls[0]).toMatchObject({ width: 1200, height: 630, fit: "contain" });
    expect(images.calls[0].background).toBeUndefined();
  });

  it("maps named backgrounds to CSS colors", async () => {
    const images = fakeImages();
    await renderCustomSize(
      { source: new Uint8Array([1]), sourceFormat: "png", width: 100, height: 100, background: "white" },
      images
    );
    expect(images.calls[0].background).toBe("#ffffff");

    const images2 = fakeImages();
    await renderCustomSize(
      { source: new Uint8Array([1]), sourceFormat: "png", width: 100, height: 100, background: "black" },
      images2
    );
    expect(images2.calls[0].background).toBe("#000000");
  });

  it("padding does a two-step resize: inner box then exact canvas", async () => {
    const images = fakeImages();
    await renderCustomSize(
      { source: new Uint8Array([1]), sourceFormat: "png", width: 1000, height: 1000, background: "transparent", paddingRatio: 0.2 },
      images
    );
    // Two transforms: inner (1-0.2)=800 box, then the exact 1000 canvas.
    expect(images.calls).toHaveLength(2);
    expect(images.calls[0]).toMatchObject({ width: 800, height: 800, fit: "contain" });
    expect(images.calls[1]).toMatchObject({ width: 1000, height: 1000, fit: "contain" });
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
