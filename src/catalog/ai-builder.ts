import { ScannedFile } from "../scanner/scanner";
import { SvgDimensions, PngDimensions } from "../scanner/file-metadata";

/**
 * Produces catalog metadata for a scanned file. `scan.ts` only ever uses the
 * deterministic `RuleBuilder` (zero AI) — this interface stays abstract so an
 * LLM-backed builder could be reintroduced later without touching the scanner.
 */
export interface MetadataBuilder {
  buildAssetMetadata(
    file: ScannedFile,
    dimensions: SvgDimensions | PngDimensions | null
  ): Promise<AiInferredMetadata>;
}

export interface AiInferredMetadata {
  brand_id: string;
  display_name: string;
  aliases: string[];
  asset_type: string;
  variant: string;
  language: string | null;
  color: string | null;
  background: string;
  layout: string | null;
  usage: string[];
  confidence: number;
  inferred_from: string[];
  review_status: "accepted" | "needs_review" | "ignored";
  review_reason: string | null;
}

/**
 * Deterministic filename rules that override the AI's shape guess. A file named
 * mark/square/icon/favicon (or 正方形) is a square asset, and mark/favicon files
 * are brand marks — these signals are reliable enough that we don't leave them
 * to the model. Mutates and returns the metadata, records why in inferred_from.
 */
export function applyFilenameShapeRules(
  fileName: string,
  metadata: AiInferredMetadata
): AiInferredMetadata {
  const n = fileName.toLowerCase();
  const isSquare =
    ["mark", "square", "icon", "favicon"].some((k) => n.includes(k)) || fileName.includes("正方形");
  const isMark = n.includes("mark") || n.includes("favicon");

  let applied = false;
  if (isSquare && metadata.layout !== "square") {
    metadata.layout = "square";
    applied = true;
  }
  if (isMark && metadata.asset_type !== "mark") {
    metadata.asset_type = "mark";
    applied = true;
  }
  if (applied && !metadata.inferred_from.includes("filename_shape_rule")) {
    metadata.inferred_from.push("filename_shape_rule");
  }
  return metadata;
}
