/**
 * Pure dimension validation shared by the Node renderer (sharp/resvg) and the
 * Worker renderer (svg2png-wasm + Images). No platform dependencies, so both
 * backends import it without dragging the other's native deps into the graph.
 */
export function validateDimensions(
  width: number,
  height: number,
  maxSize: number
): { valid: boolean; error?: string } {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return { valid: false, error: "尺寸必須為整數。" };
  }
  if (width <= 0 || height <= 0) {
    return { valid: false, error: "尺寸必須大於零。" };
  }
  if (width > maxSize || height > maxSize) {
    return { valid: false, error: `尺寸不可超過 ${maxSize}x${maxSize}。` };
  }
  return { valid: true };
}
