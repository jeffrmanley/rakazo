import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** What an authenticator app shows for an `otpauth://` URI, `steps` periods away from `now`. */
export function totpCode(uri: string, steps = 0, now = Date.now()): string {
  const url = new URL(uri);
  const secret = url.searchParams.get("secret");
  if (!secret) throw new Error("otpauth URI without a secret");
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period) + steps));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** A six-digit code no authenticator would accept now (outside the ±1 step window). */
export function wrongTotpCode(uri: string, now = Date.now()): string {
  const valid = new Set([-1, 0, 1].map((steps) => totpCode(uri, steps, now)));
  for (let candidate = 0; ; candidate += 1) {
    const code = String((Number(totpCode(uri, 0, now)) + 1 + candidate) % 1_000_000).padStart(
      6,
      "0",
    );
    if (!valid.has(code)) return code;
  }
}

/** Waits out the last seconds of a TOTP period so a code cannot roll over mid-check. */
export async function awayFromTotpBoundary(period = 30, marginMs = 4_000): Promise<void> {
  const left = period * 1000 - (Date.now() % (period * 1000));
  if (left < marginMs) await new Promise((resolve) => setTimeout(resolve, left + 250));
}
