export interface SvgDimensions {
  viewBoxWidth: number;
  viewBoxHeight: number;
  width: number | null;
  height: number | null;
}

export interface PngDimensions {
  width: number;
  height: number;
}

export function extractSvgDimensions(svgContent: string): SvgDimensions | null {
  const viewBoxMatch = svgContent.match(/viewBox=["']([^"']+)["']/);
  if (!viewBoxMatch) return null;

  const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length < 4 || parts.some(isNaN)) return null;

  const [, , viewBoxWidth, viewBoxHeight] = parts;

  const widthMatch = svgContent.match(/\bwidth=["']([^"']+)["']/);
  const heightMatch = svgContent.match(/\bheight=["']([^"']+)["']/);

  const width = widthMatch ? parseFloat(widthMatch[1]) : null;
  const height = heightMatch ? parseFloat(heightMatch[1]) : null;

  return {
    viewBoxWidth,
    viewBoxHeight,
    width: width && !isNaN(width) ? width : null,
    height: height && !isNaN(height) ? height : null,
  };
}

/**
 * Normalize a downloaded file's content into intrinsic pixel dimensions,
 * dispatching on MIME type. Returns null for unsupported formats (e.g. AI/EPS)
 * or when dimensions can't be determined.
 */
export function extractIntrinsicDimensions(
  buffer: Uint8Array,
  mimeType: string
): PngDimensions | null {
  if (mimeType === "image/svg+xml") {
    const svg = extractSvgDimensions(new TextDecoder("utf-8").decode(buffer));
    if (!svg) return null;
    // Prefer explicit width/height; fall back to the viewBox extents.
    const width = svg.width ?? svg.viewBoxWidth;
    const height = svg.height ?? svg.viewBoxHeight;
    return { width: Math.round(width), height: Math.round(height) };
  }
  if (mimeType === "image/png") {
    return extractPngDimensions(buffer);
  }
  return null;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function extractPngDimensions(buffer: Uint8Array): PngDimensions | null {
  // PNG header: 8 bytes signature, then IHDR chunk
  // IHDR starts at byte 8: 4 bytes length, 4 bytes "IHDR", 4 bytes width, 4 bytes height
  if (buffer.length < 24) return null;

  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return null;
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);

  if (width === 0 || height === 0) return null;
  return { width, height };
}
