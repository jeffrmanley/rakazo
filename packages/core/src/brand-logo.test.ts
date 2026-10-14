import { describe, expect, it } from "vitest";
import { BRAND_LOGO_MAX_BYTES, crc32, inspectBrandLogo } from "./brand-logo.js";

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
const u32be = (value: number) => [
  value >>> 24,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
const u16be = (value: number) => [value >> 8, value & 255];
const u16le = (value: number) => [value & 255, value >> 8];
const u24le = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255];
const u32le = (value: number) => u32be(value).reverse();

function png(width: number, height: number, options: { chunkType?: string } = {}): Uint8Array {
  const type = ascii(options.chunkType ?? "IHDR");
  const data = [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0];
  const crc = crc32(new Uint8Array([...type, ...data]));
  const iend = [...u32be(0), ...ascii("IEND"), ...u32be(crc32(new Uint8Array(ascii("IEND"))))];
  return new Uint8Array([
    0x89,
    ...ascii("PNG"),
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...type,
    ...data,
    ...u32be(crc),
    ...iend,
  ]);
}

function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...new Array(9).fill(0), 0xff, 0xd9]);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const body = [...ascii("WEBP"), ...ascii(chunk), ...u32le(payload.length), ...payload];
  return new Uint8Array([...ascii("RIFF"), ...u32le(body.length), ...body]);
}

const webpLossy = (width: number, height: number) =>
  riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height), 0, 0]);
const webpLossless = (width: number, height: number) => {
  const bits = (width - 1) | ((height - 1) << 14);
  return riff("VP8L", [0x2f, ...u32le(bits >>> 0), 0, 0, 0]);
};
const webpExtended = (width: number, height: number) =>
  riff("VP8X", [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);

describe("inspectBrandLogo", () => {
  it("accepts PNG, JPEG and WebP by their magic bytes and reads the size", () => {
    expect(inspectBrandLogo(png(128, 64))).toEqual({
      ok: true,
      mime: "image/png",
      width: 128,
      height: 64,
    });
    expect(inspectBrandLogo(jpeg(200, 300))).toEqual({
      ok: true,
      mime: "image/jpeg",
      width: 200,
      height: 300,
    });
    for (const [bytes, width, height] of [
      [webpLossy(320, 240), 320, 240],
      [webpLossless(512, 100), 512, 100],
      [webpExtended(4096, 64), 4096, 64],
    ] as const) {
      expect(inspectBrandLogo(bytes)).toEqual({ ok: true, mime: "image/webp", width, height });
    }
  });

  it("skips JPEG segments and fill bytes before the frame header", () => {
    const base = jpeg(100, 100);
    const comment = [0xff, 0xfe, ...u16be(6), ...ascii("hey!")];
    const withComment = new Uint8Array([...base.slice(0, 2), 0xff, ...comment, ...base.slice(2)]);
    expect(inspectBrandLogo(withComment)).toMatchObject({ ok: true, width: 100, height: 100 });
  });

  it("rejects SVG, GIF, an executable and other content", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>x</script></svg>',
    );
    const xmlSvg = new TextEncoder().encode('<?xml version="1.0"?><svg/>');
    const gif = new Uint8Array([...ascii("GIF89a"), ...u16le(100), ...u16le(100), 0, 0, 0]);
    const exe = new Uint8Array([...ascii("MZ"), 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]);
    const elf = new Uint8Array([0x7f, ...ascii("ELF"), 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const html = new TextEncoder().encode("<html><body>hi</body></html>");
    for (const bytes of [svg, xmlSvg, gif, exe, elf, html]) {
      expect(inspectBrandLogo(bytes)).toEqual({ ok: false, reason: "unsupported_type" });
    }
  });

  it("rejects a PNG whose header chunk was renamed or tampered with", () => {
    expect(inspectBrandLogo(png(128, 128, { chunkType: "IHDX" }))).toEqual({
      ok: false,
      reason: "corrupt",
    });
    const flipped = png(128, 128);
    flipped[19] = (flipped[19] ?? 0) ^ 0x01; // width byte changes, CRC no longer matches
    expect(inspectBrandLogo(flipped)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("rejects truncated headers", () => {
    const cases = [
      png(128, 128).slice(0, 20),
      png(128, 128).slice(0, 8),
      jpeg(128, 128).slice(0, 10),
      jpeg(128, 128).slice(0, 25),
      webpLossy(128, 128).slice(0, 24),
      webpLossless(128, 128).slice(0, 22),
      webpExtended(128, 128).slice(0, 27),
      new Uint8Array([0xff, 0xd8, 0xff]),
    ];
    for (const bytes of cases) {
      expect(inspectBrandLogo(bytes)).toEqual({ ok: false, reason: "corrupt" });
    }
  });

  it("rejects a JPEG that ends or starts scanning before any frame header", () => {
    expect(inspectBrandLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({
      ok: false,
      reason: "corrupt",
    });
    expect(
      inspectBrandLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0xff, 0xd9])),
    ).toEqual({ ok: false, reason: "corrupt" });
  });

  it("accepts 64 to 4096 pixels on each side", () => {
    for (const [width, height] of [
      [64, 64],
      [4096, 4096],
      [64, 4096],
    ]) {
      expect(inspectBrandLogo(png(width!, height!)).ok).toBe(true);
      expect(inspectBrandLogo(jpeg(width!, height!)).ok).toBe(true);
      expect(inspectBrandLogo(webpExtended(width!, height!)).ok).toBe(true);
    }
    for (const [width, height] of [
      [63, 128],
      [128, 63],
      [4097, 128],
      [128, 4097],
      [8000, 8000],
    ]) {
      expect(inspectBrandLogo(png(width!, height!))).toEqual({ ok: false, reason: "dimensions" });
      expect(inspectBrandLogo(jpeg(width!, height!))).toEqual({ ok: false, reason: "dimensions" });
    }
    expect(inspectBrandLogo(webpLossy(63, 63))).toEqual({ ok: false, reason: "dimensions" });
    expect(inspectBrandLogo(webpLossless(8000, 100))).toEqual({ ok: false, reason: "dimensions" });
  });

  it("rejects files over 1 MB and empty files", () => {
    const big = new Uint8Array(BRAND_LOGO_MAX_BYTES + 1);
    big.set(png(128, 128));
    expect(inspectBrandLogo(big)).toEqual({ ok: false, reason: "too_large" });
    const atLimit = new Uint8Array(BRAND_LOGO_MAX_BYTES);
    atLimit.set(png(128, 128));
    expect(inspectBrandLogo(atLimit).ok).toBe(true);
    expect(inspectBrandLogo(new Uint8Array())).toEqual({ ok: false, reason: "empty" });
  });
});

describe("crc32", () => {
  it("matches the reference value", () => {
    expect(crc32(new Uint8Array(ascii("123456789")))).toBe(0xcbf43926);
  });
});
