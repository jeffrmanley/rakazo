/**
 * Dependency-free QR Code encoder (byte mode, UTF-8), structured after Project Nayuki's
 * QR Code generator (MIT): https://www.nayuki.io/page/qr-code-generator-library
 */

/** Error-correction level; the app uses M. */
export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrOptions {
  /** Defaults to "M". */
  ecc?: QrEcc;
  /** Force a mask 0-7 instead of the lowest-penalty one (testing aid). */
  mask?: number;
}

/** Quiet zone, in modules, that scanners expect around the symbol. */
export const QR_QUIET_ZONE = 4;

const ECC_INDEX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Error-correction codewords per block, indexed [ecc][version]. */
const ECC_PER_BLOCK = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];

/** Error-correction blocks, indexed [ecc][version]. */
const BLOCKS = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
    37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number, ecc: number): number {
  return (rawDataModules(ver) >>> 3) - ECC_PER_BLOCK[ecc]![ver]! * BLOCKS[ecc]![ver]!;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMul(coef, factor);
    });
  }
  return result;
}

function pickVersion(byteLength: number, ecc: number): number {
  for (let ver = 1; ver <= 40; ver++) {
    const used = 4 + (ver < 10 ? 8 : 16) + byteLength * 8;
    if (used <= dataCodewords(ver, ecc) * 8) return ver;
  }
  const max = (dataCodewords(40, ecc) * 8 - 20) >>> 3;
  throw new Error(`QR data too long: ${byteLength} bytes exceeds the ${max}-byte capacity`);
}

function dataWithEcc(bytes: Uint8Array, ver: number, ecc: number): number[] {
  const capacity = dataCodewords(ver, ecc) * 8;
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    data.push(byte);
  }

  const numBlocks = BLOCKS[ecc]![ver]!;
  const blockEccLen = ECC_PER_BLOCK[ecc]![ver]!;
  const rawCodewords = rawDataModules(ver) >>> 3;
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

class QrSymbol {
  readonly size: number;
  readonly dark: Uint8Array;
  readonly fn: Uint8Array;

  constructor(
    readonly ver: number,
    readonly formatEcc: number,
  ) {
    this.size = ver * 4 + 17;
    this.dark = new Uint8Array(this.size * this.size);
    this.fn = new Uint8Array(this.size * this.size);
  }

  get(x: number, y: number): number {
    return this.dark[y * this.size + x]!;
  }

  setFn(x: number, y: number, on: boolean): void {
    this.dark[y * this.size + x] = on ? 1 : 0;
    this.fn[y * this.size + x] = 1;
  }

  drawFunctionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) this.setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    const pos = alignmentPositions(this.ver);
    const last = pos.length - 1;
    pos.forEach((ay, i) => {
      pos.forEach((ax, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            this.setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      });
    });
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFormatBits(mask: number): void {
    const data = (this.formatEcc << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(i));
    this.setFn(8, 7, bit(6));
    this.setFn(8, 8, bit(7));
    this.setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFn(8, size - 15 + i, bit(i));
    this.setFn(8, size - 8, true);
  }

  drawVersion(): void {
    if (this.ver < 7) return;
    let rem = this.ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFn(a, b, on);
      this.setFn(b, a, on);
    }
  }

  drawCodewords(data: readonly number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          const idx = y * size + x;
          if (!this.fn[idx] && i < data.length * 8) {
            this.dark[idx] = (data[i >>> 3]! >>> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    const { size } = this;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        if (!this.fn[idx] && maskHit(mask, x, y)) this.dark[idx]! ^= 1;
      }
    }
  }

  penalty(): number {
    const { size } = this;
    let result = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let runColor = 0;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const color = pass === 0 ? this.get(b, a) : this.get(a, b);
          if (color === runColor) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            this.addHistory(run, history);
            if (!runColor) result += this.finderPatterns(history) * 40;
            runColor = color;
            run = 1;
          }
        }
        if (runColor) {
          this.addHistory(run, history);
          run = 0;
        }
        this.addHistory(run + size, history);
        result += this.finderPatterns(history) * 40;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.get(x, y);
        if (c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) {
          result += 3;
        }
      }
    }
    const total = size * size;
    const dark = this.dark.reduce((sum, v) => sum + v, 0);
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * 10;
  }

  private addHistory(run: number, history: number[]): void {
    history.pop();
    history.unshift(history[0] === 0 ? run + this.size : run);
  }

  private finderPatterns(h: readonly number[]): number {
    const n = h[1]!;
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (
      (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) +
      (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0)
    );
  }
}

/**
 * Encodes `text` as UTF-8 in byte mode at the smallest version that fits.
 * Returns rows of modules (true = dark) without a quiet zone; throws if the data is too long.
 */
export function encodeQr(text: string, options: QrOptions = {}): boolean[][] {
  const ecc = options.ecc ?? "M";
  const { mask } = options;
  if (mask !== undefined && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) {
    throw new Error(`QR mask must be an integer 0-7, got ${mask}`);
  }
  const bytes = new TextEncoder().encode(text);
  const ver = pickVersion(bytes.length, ECC_INDEX[ecc]);
  const qr = new QrSymbol(ver, FORMAT_BITS[ecc]);
  qr.drawFunctionPatterns();
  qr.drawCodewords(dataWithEcc(bytes, ver, ECC_INDEX[ecc]));

  let chosen = mask ?? 0;
  if (mask === undefined) {
    let best = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 8; m++) {
      qr.applyMask(m);
      qr.drawFormatBits(m);
      const score = qr.penalty();
      if (score < best) {
        best = score;
        chosen = m;
      }
      qr.applyMask(m);
    }
  }
  qr.applyMask(chosen);
  qr.drawFormatBits(chosen);

  return Array.from({ length: qr.size }, (_, y) =>
    Array.from({ length: qr.size }, (_, x) => qr.get(x, y) === 1),
  );
}

/**
 * SVG path `d` drawing each row's dark runs as `M{x},{y}h{n}v1h-{n}z`, in module units.
 * Coordinates are shifted by `offset` (default 0, i.e. no quiet zone included).
 */
export function qrSvgPath(modules: boolean[][], offset = 0): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      const start = x;
      while (x + 1 < row.length && row[x + 1]) x++;
      const len = x - start + 1;
      parts.push(`M${start + offset},${y + offset}h${len}v1h-${len}z`);
    }
  });
  return parts.join("");
}

/**
 * Convenience for rendering: `size` is the module count and `path` already includes the
 * 4-module quiet-zone offset, so use `<svg viewBox="0 0 {size+8} {size+8}"><path d={path}/>`.
 */
export function qrSvg(text: string): { size: number; path: string } {
  const modules = encodeQr(text);
  return { size: modules.length, path: qrSvgPath(modules, QR_QUIET_ZONE) };
}
