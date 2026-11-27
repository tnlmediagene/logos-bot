import { describe, test, expect } from "vitest";
import { BrandMatcher, BrandSource } from "../../src/bot/brand-matcher";

const brands: BrandSource[] = [
  { id: "inside-硬塞", display_name: "INSIDE 硬塞", aliases: ["INSIDE 硬塞"] },
  { id: "techinsider", display_name: "techinsider", aliases: ["techinsider"] },
  { id: "bi", display_name: "BI", aliases: ["BI"] },
  { id: "the-news-lens-關鍵評論網", display_name: "The News Lens 關鍵評論網", aliases: ["The News Lens 關鍵評論網"] },
  { id: "tnl-mediagene", display_name: "TNL Mediagene", aliases: ["TNL Mediagene"] },
];
const config = {
  "inside-硬塞": { aliases: ["INSIDE", "硬塞"], notes: "" },
  "techinsider": { aliases: ["techinsider", "tech-insider"], notes: "" },
  "bi": { aliases: ["BI", "business insider"], notes: "" },
  "the-news-lens-關鍵評論網": { aliases: ["tnl", "關鍵評論網"], notes: "" },
  "tnl-mediagene": { aliases: ["tnl", "tnl mediagene", "tnmg"], notes: "" },
};

describe("BrandMatcher", () => {
  test("'INSIDE' matches only 硬塞, not techinsider/business insider", () => {
    const m = new BrandMatcher(brands, config);
    expect(m.match("我要 INSIDE 的 logo")).toEqual(["inside-硬塞"]);
  });

  test("CJK alias matches by containment", () => {
    const m = new BrandMatcher(brands, config);
    expect(m.match("給我關鍵評論網的圖")).toEqual(["the-news-lens-關鍵評論網"]);
  });

  test("no alias present → empty", () => {
    const m = new BrandMatcher(brands, config);
    expect(m.match("隨便給我一個東西")).toEqual([]);
  });

  test("ambiguous 'tnl' matches both news-lens and mediagene", () => {
    const m = new BrandMatcher(brands, config);
    const result = m.match("我要 tnl 的檔案").sort();
    expect(result).toContain("the-news-lens-關鍵評論網");
    expect(result).toContain("tnl-mediagene");
  });
});

describe("BrandMatcher — a longer alias shadows the fragment it contains", () => {
  // Mirrors the real collision: 關鍵評論網 carries the two-character alias
  // 關鍵, which CJK containment makes fire on every name that starts with it.
  const brands: BrandSource[] = [
    { id: "the-news-lens-關鍵評論網", display_name: "The News Lens 關鍵評論網", aliases: [] },
    { id: "tnl-digitech-group", display_name: "關鍵數位科技集團", aliases: [] },
    { id: "tnl-mediagene", display_name: "TNL Mediagene", aliases: [] },
    { id: "icook-愛料理", display_name: "iCook 愛料理", aliases: [] },
  ];
  const config = {
    "the-news-lens-關鍵評論網": { aliases: ["關鍵", "關鍵評論網", "tnl"], notes: "" },
    "tnl-digitech-group": {
      aliases: ["關鍵數位科技集團", "關鍵數位科技", "數位科技集團", "集團", "關鍵集團"],
      notes: "",
    },
    "tnl-mediagene": { aliases: ["TNL Mediagene", "tnmg"], notes: "" },
    "icook-愛料理": { aliases: ["愛料理"], notes: "" },
  };
  const matcher = () => new BrandMatcher(brands, config);

  test("關鍵 on its own still means 關鍵評論網", () => {
    expect(matcher().match("關鍵的 logo")).toEqual(["the-news-lens-關鍵評論網"]);
  });

  test("關鍵數位科技集團 resolves to the group, not 關鍵評論網", () => {
    expect(matcher().match("我要關鍵數位科技集團的 logo")).toEqual(["tnl-digitech-group"]);
  });

  test("關鍵數位科技 without 集團 still resolves to the group", () => {
    expect(matcher().match("關鍵數位科技 logo")).toEqual(["tnl-digitech-group"]);
  });

  test("關鍵集團 resolves to the group", () => {
    expect(matcher().match("關鍵集團 logo")).toEqual(["tnl-digitech-group"]);
  });

  test("TNL Mediagene no longer drags in 關鍵評論網 through its tnl alias", () => {
    expect(matcher().match("TNL Mediagene 的 logo")).toEqual(["tnl-mediagene"]);
  });

  test("two brands named side by side both survive — neither alias is inside the other", () => {
    expect(matcher().match("愛料理跟關鍵評論網的 logo").sort()).toEqual([
      "icook-愛料理",
      "the-news-lens-關鍵評論網",
    ]);
  });

  test("集團 on its own is the group", () => {
    expect(matcher().match("集團 logo")).toEqual(["tnl-digitech-group"]);
  });
});
