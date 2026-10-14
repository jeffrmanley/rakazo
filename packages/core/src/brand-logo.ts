/**
 * Validation for an uploaded brand logo. The type comes from the file's magic
 * bytes only (a declared content type or file name is never trusted) and the
 * size from the image header, so no image library is needed. SVG and every
 * other format are refused: an uploaded SVG can carry script.
 */
export const BRAND_LOGO_MAX_BYTES = 1024 * 1024;
export const BRAND_LOGO_MIN_SIDE = 64;
export const BRAND_LOGO_MAX_SIDE = 4096;

export type BrandLogoMime = "image/png" | "image/jpeg" | "image/webp";

export type BrandLogoRejection =
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "corrupt"
  | "dimensions";

export type BrandLogoCheck =
  | { ok: true; mime: BrandLogoMime; width: number; height: number }
  | { ok: false; reason: BrandLogoRejection };

type Header = { mime: BrandLogoMime; width: number; height: number } | "corrupt";

export function inspectBrandLogo(bytes: Uint8Array): BrandLogoCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  if (bytes.byteLength > BRAND_LOGO_MAX_BYTES) return { ok: false, reason: "too_large" };
  const header = isPng(bytes)
    ? pngHeader(bytes)
    : isJpeg(bytes)
      ? jpegHeader(bytes)
      : isWebp(bytes)
        ? webpHeader(bytes)
        : undefined;
  if (!header) return { ok: false, reason: "unsupported_type" };
  if (header === "corrupt") return { ok: false, reason: "corrupt" };
  const { width, height } = header;
  if (!withinSide(width) || !withinSide(height)) return { ok: false, reason: "dimensions" };
  return { ok: true, ...header };
}

/** Pixel size of a logo that already passed {@link inspectBrandLogo}. */
export function brandLogoSize(bytes: Uint8Array): { width: number; height: number } | null {
  const check = inspectBrandLogo(bytes);
  return check.ok ? { width: check.width, height: check.height } : null;
}

function withinSide(value: number): boolean {
  return value >= BRAND_LOGO_MIN_SIDE && value <= BRAND_LOGO_MAX_SIDE;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) return false;
  return prefix.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) +
    bytes[offset + 3]! * 0x1000000
  );
}

function isPng(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_SIGNATURE);
}

/** The first chunk must be a 13-byte IHDR whose CRC matches. */
function pngHeader(bytes: Uint8Array): Header {
  if (bytes.byteLength < 33) return "corrupt";
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") return "corrupt";
  if (crc32(bytes.subarray(12, 29)) !== u32be(bytes, 29)) return "corrupt";
  return { mime: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function isJpeg(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0xd8, 0xff]);
}

/** Walk the marker segments to the first start-of-frame header. */
function jpegHeader(bytes: Uint8Array): Header {
  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return "corrupt";
    while (bytes[offset] === 0xff) offset += 1; // fill bytes
    if (offset >= bytes.byteLength) return "corrupt";
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return "corrupt";
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return "corrupt";
    const length = u16be(bytes, offset);
    if (length < 2) return "corrupt";
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 7 || offset + 7 > bytes.byteLength) return "corrupt";
      return {
        mime: "image/jpeg",
        height: u16be(bytes, offset + 3),
        width: u16be(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return "corrupt";
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
}

function webpHeader(bytes: Uint8Array): Header {
  if (u32le(bytes, 4) + 8 > bytes.byteLength || bytes.byteLength < 20) return "corrupt";
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    if (bytes.byteLength < 30 || !startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return "corrupt";
    return {
      mime: "image/webp",
      width: u16le(bytes, 26) & 0x3fff,
      height: u16le(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return "corrupt";
    const bits = u32le(bytes, 21);
    return {
      mime: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    if (bytes.byteLength < 30) return "corrupt";
    return { mime: "image/webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  return "corrupt";
}

let crcTable: Uint32Array | undefined;

/** CRC-32 (IEEE), as PNG chunks use. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
