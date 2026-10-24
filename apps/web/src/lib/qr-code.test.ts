import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeQr, QR_QUIET_ZONE, qrSvg, qrSvgPath } from "./qr-code.js";

const OTPAUTH =
  "otpauth://totp/withJZ%20Crew:someone%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=withJZ%20Crew&digits=6&period=30";

const rows = (m: boolean[][]) => m.map((r) => r.map((v) => (v ? "#" : ".")).join(""));
const sha256 = (m: boolean[][]) =>
  createHash("sha256")
    .update(m.map((r) => r.map((v) => (v ? "1" : "0")).join("")).join("\n"))
    .digest("hex");

/** Reads the 5 format-info data bits (ecc level, mask) from the copy around the top-left finder. */
function readFormat(m: boolean[][]): { ecc: number; mask: number } {
  const bit = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= bit(8, i) << i;
  bits |= (bit(8, 7) << 6) | (bit(8, 8) << 7) | (bit(7, 8) << 8);
  for (let i = 9; i < 15; i++) bits |= bit(14 - i, 8) << i;
  const data = (bits ^ 0x5412) >>> 10;
  return { ecc: data >>> 3, mask: data & 7 };
}

function expectFinder(m: boolean[][], left: number, top: number) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      expect(m[top + dy]![left + dx], `finder at ${left},${top} (+${dx},+${dy})`).toBe(ring !== 2);
    }
  }
}

describe("encodeQr", () => {
  it("uses version 1 (21x21) for a short string", () => {
    const m = encodeQr("hello");
    expect(m).toHaveLength(21);
    for (const row of m) expect(row).toHaveLength(21);
  });

  it("grows to 4v+17 modules as the data grows", () => {
    expect(encodeQr("x".repeat(14))).toHaveLength(21);
    expect(encodeQr("x".repeat(15))).toHaveLength(25);
    expect(encodeQr("x".repeat(213))).toHaveLength(4 * 10 + 17);
    expect(encodeQr(OTPAUTH)).toHaveLength(4 * 8 + 17);
    expect(encodeQr("x".repeat(2331))).toHaveLength(4 * 40 + 17);
  });

  it("draws finder patterns in three corners", () => {
    const m = encodeQr(OTPAUTH);
    const n = m.length;
    expectFinder(m, 0, 0);
    expectFinder(m, n - 7, 0);
    expectFinder(m, 0, n - 7);
    for (let i = 0; i < 8; i++) {
      expect(m[7]![i]).toBe(false);
      expect(m[i]![n - 8]).toBe(false);
      expect(m[n - 8]![i]).toBe(false);
    }
  });

  it("draws alternating timing patterns on row and column 6", () => {
    const m = encodeQr(OTPAUTH);
    for (let i = 8; i < m.length - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
  });

  it("writes level M and the selected mask into the format bits", () => {
    expect(readFormat(encodeQr(OTPAUTH))).toEqual({ ecc: 0, mask: 2 });
    expect(readFormat(encodeQr(OTPAUTH, { mask: 5 }))).toEqual({ ecc: 0, mask: 5 });
    expect(readFormat(encodeQr("hello", { ecc: "L" })).ecc).toBe(1);
  });

  it("is deterministic", () => {
    expect(encodeQr(OTPAUTH)).toEqual(encodeQr(OTPAUTH));
  });

  it("encodes text as UTF-8 bytes", () => {
    expect(encodeQr("é".repeat(7))).toHaveLength(21);
    expect(encodeQr("é".repeat(8))).toHaveLength(25);
  });

  it("throws a clear error when the data exceeds capacity", () => {
    expect(() => encodeQr("x".repeat(2331))).not.toThrow();
    expect(() => encodeQr("x".repeat(2332))).toThrow(
      "QR data too long: 2332 bytes exceeds the 2331-byte capacity",
    );
  });

  it("rejects an invalid forced mask", () => {
    expect(() => encodeQr("hello", { mask: 8 })).toThrow("QR mask must be an integer 0-7");
  });

  // Expected values were cross-checked module-for-module against an independent encoder (toqr).
  it("matches the known-answer matrix for 'hello'", () => {
    expect(rows(encodeQr("hello"))).toEqual([
      "#######..##...#######",
      "#.....#.##....#.....#",
      "#.###.#..#.##.#.###.#",
      "#.###.#...##..#.###.#",
      "#.###.#.##..#.#.###.#",
      "#.....#.....#.#.....#",
      "#######.#.#.#.#######",
      "..........###........",
      "#.#.#.#..#.#....#..#.",
      "..#.##....#...#....##",
      ".#.#..#.###.#...#####",
      "##..#.........#....#.",
      ".##.#.##..#.#.#.#....",
      "........####.#.#..###",
      "#######...##.###..###",
      "#.....#...####.##....",
      "#.###.#.#.##.###...##",
      "#.###.#..#....##..##.",
      "#.###.#.###.#...#.#.#",
      "#.....#..#....#.#..#.",
      "#######.###.#.##...##",
    ]);
  });

  it("matches the known-answer matrix for an otpauth URI", () => {
    expect(sha256(encodeQr(OTPAUTH))).toBe(
      "0b9060f8619718b3b0f62febbc52884cdf99830fc0e4bb092446231b9210c434",
    );
    expect(sha256(encodeQr(OTPAUTH, { mask: 4 }))).toBe(
      "d41091c64912c04319f13bc4e8464f6032ec779a05bd68e3a1702b30ea8e2a9b",
    );
  });
});

describe("qrSvgPath", () => {
  it("merges each row's dark runs into one rectangle", () => {
    const m = [
      [true, true, false, true],
      [false, false, false, false],
      [false, true, true, true],
    ];
    expect(qrSvgPath(m)).toBe("M0,0h2v1h-2zM3,0h1v1h-1zM1,2h3v1h-3z");
    expect(qrSvgPath(m, 4)).toBe("M4,4h2v1h-2zM7,4h1v1h-1zM5,6h3v1h-3z");
  });

  it("covers exactly the dark modules", () => {
    const m = encodeQr(OTPAUTH);
    const dark = m.flat().filter(Boolean).length;
    const drawn = [...qrSvgPath(m).matchAll(/h(\d+)v1/g)].reduce((s, r) => s + Number(r[1]), 0);
    expect(drawn).toBe(dark);
  });
});

describe("qrSvg", () => {
  it("returns the module count and a path offset by the quiet zone", () => {
    const { size, path } = qrSvg("hello");
    expect(size).toBe(21);
    expect(QR_QUIET_ZONE).toBe(4);
    expect(path.startsWith("M4,4h7v1h-7z")).toBe(true);
    expect(path).toBe(qrSvgPath(encodeQr("hello"), 4));
  });
});
