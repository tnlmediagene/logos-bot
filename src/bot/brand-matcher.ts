import { BrandConfigEntry } from "../config/brands-config";

export interface BrandSource {
  id: string;
  display_name: string;
  aliases: string[];
}

const CJK = /[一-鿿぀-ヿ]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `alias` occurs in `text` at word boundaries (ASCII) or by
 *  containment (CJK, which has no word delimiters). Case-insensitive. */
function aliasMatches(text: string, alias: string): boolean {
  const t = text.toLowerCase();
  const a = alias.toLowerCase().trim();
  if (!a) return false;
  if (CJK.test(a)) return a.length >= 2 && t.includes(a);
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(a)}([^a-z0-9]|$)`, "i");
  return re.test(text);
}

export class BrandMatcher {
  private table: { id: string; aliases: string[] }[];

  constructor(brands: BrandSource[], config: Record<string, BrandConfigEntry>) {
    this.table = brands.map((b) => {
      const configAliases = config[b.id]?.aliases ?? [];
      const aliases = [...new Set([b.display_name, ...b.aliases, ...configAliases])];
      return { id: b.id, aliases };
    });
  }

  /**
   * Brands whose aliases appear in `text`.
   *
   * A brand is dropped when EVERY alias it matched is contained in a longer
   * alias that another matched brand contributed — that longer alias is the
   * more specific reading of the same words, so the shorter one is only a
   * fragment of it. "關鍵數位科技集團" matches 關鍵評論網's two-character
   * alias 關鍵 purely because CJK aliases match by containment; the group's
   * own full name is the real hit, so 關鍵評論網 steps aside. Likewise "TNL
   * Mediagene" no longer drags in 關鍵評論網 through its "tnl" alias.
   *
   * Only overlapping aliases suppress each other, never unrelated ones: in
   * "愛料理跟關鍵評論網的 logo" neither alias sits inside the other, so both
   * brands survive and the caller still asks which one was meant.
   */
  match(text: string): string[] {
    const matched = this.table
      .map((brand) => ({ id: brand.id, hits: brand.aliases.filter((a) => aliasMatches(text, a)) }))
      .filter((brand) => brand.hits.length > 0);
    if (matched.length < 2) return matched.map((brand) => brand.id);

    const shadowed = (alias: string, byBrandId: string): boolean =>
      matched.some(
        (other) =>
          other.id !== byBrandId &&
          other.hits.some(
            (h) => h.length > alias.length && h.toLowerCase().includes(alias.toLowerCase())
          )
      );

    // Shadowing strictly shortens the alias, so two brands can never shadow
    // each other and this can never empty the list.
    return matched
      .filter((brand) => brand.hits.some((alias) => !shadowed(alias, brand.id)))
      .map((brand) => brand.id);
  }
}
