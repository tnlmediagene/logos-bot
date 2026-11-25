import { describe, it, expect } from "vitest";
import { applyFilenameShapeRules, AiInferredMetadata } from "../../src/catalog/ai-builder";

// AiBuilder (the LLM-backed implementation) was removed along with the rest of
// the unused AI-assisted-scan stack — scan.ts only ever uses the deterministic
// RuleBuilder. `applyFilenameShapeRules` is pure, platform-agnostic logic that
// stayed behind in ai-builder.ts for a future LLM-backed builder to reuse.
describe("applyFilenameShapeRules", () => {
  const base = (): AiInferredMetadata => ({
    brand_id: "b", display_name: "B", aliases: [],
    asset_type: "logo", variant: "logo", language: null, color: null,
    background: "transparent", layout: "horizontal", usage: [],
    confidence: 0.9, inferred_from: [], review_status: "accepted", review_reason: null,
  });

  it("marks mark/square/icon/favicon/正方形 filenames as square layout", () => {
    for (const name of ["logo-mark.svg", "brand-square.png", "app-icon.png", "favicon.svg", "正方形版.svg"]) {
      expect(applyFilenameShapeRules(name, base()).layout).toBe("square");
    }
  });

  it("sets asset_type=mark for mark and favicon filenames", () => {
    expect(applyFilenameShapeRules("logo-mark.svg", base()).asset_type).toBe("mark");
    expect(applyFilenameShapeRules("favicon.png", base()).asset_type).toBe("mark");
    // 正方形 / square / icon are shape-only — they do not imply a mark
    expect(applyFilenameShapeRules("hero-square.png", base()).asset_type).toBe("logo");
    expect(applyFilenameShapeRules("app-icon.png", base()).asset_type).toBe("logo");
  });

  it("leaves ordinary logo filenames untouched (no rule tag)", () => {
    const m = applyFilenameShapeRules("logo-en-blue.svg", base());
    expect(m.layout).toBe("horizontal");
    expect(m.asset_type).toBe("logo");
    expect(m.inferred_from).not.toContain("filename_shape_rule");
  });
});
