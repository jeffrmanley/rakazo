import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";

const KEY = "test-encryption-key";

/** A ciphertext in the pre-v2 layout: iv | tag | enc, SHA-256 key, no AAD. */
function legacySeal(plaintext: string, tagBytes = 16): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(KEY).digest(), iv, {
    authTagLength: tagBytes,
  });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

describe("EncryptedSecretStore tamper handling", () => {
  it("still reads a legacy ciphertext with a full 16-byte tag", async () => {
    const store = new EncryptedSecretStore(KEY);
    await expect(store.load(legacySeal("legacy value"), "record-1")).resolves.toBe("legacy value");
  });

  it("refuses a legacy ciphertext sealed with a short authentication tag", async () => {
    // GCM accepts tags down to 4 bytes unless the length is pinned; a short tag is far easier
    // to forge, so only the full 16-byte tag the store writes may authenticate.
    const store = new EncryptedSecretStore(KEY);
    await expect(store.load(legacySeal("forgeable", 4), "record-1")).rejects.toThrow();
  });

  it("refuses a legacy ciphertext too short to hold an iv and a full tag", async () => {
    const store = new EncryptedSecretStore(KEY);
    const short = randomBytes(12 + 8).toString("base64");
    await expect(store.load(short, "record-1")).rejects.toThrow(/malformed/);
  });

  it("refuses a v2 ciphertext whose bytes were changed", async () => {
    const store = new EncryptedSecretStore(KEY);
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "test",
      userId: "test",
      signal: new AbortController().signal,
    };
    const record = await store.put("v2 value", context, { recordId: "record-2" });
    const raw = Buffer.from(record.ciphertext.slice(3), "base64");
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 0x01, raw.length - 1);
    await expect(store.load(`v2:${raw.toString("base64")}`, record.id)).rejects.toThrow();
  });
});
