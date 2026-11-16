// withJZ Crew (fork): regenerates assets/icon.{ico,png} and icon-macos.png from
// assets/brand/withjz-crew-a.png. Needs ffmpeg on PATH for the resampling.
// Usage: node scripts/brand-icons.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");
const source = path.join(assets, "brand", "withjz-crew-a.png");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const work = mkdtempSync(path.join(tmpdir(), "crew-icons-"));
try {
  const images = ICO_SIZES.map((size) => {
    const file = path.join(work, `${size}.png`);
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-vf",
      `scale=${size}:${size}:flags=lanczos`,
      "-pix_fmt",
      "rgba",
      file,
    ]);
    return { size, data: readFileSync(file) };
  });

  // ICO with PNG-compressed entries (Vista+). A width/height byte of 0 means 256.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, data }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  writeFileSync(
    path.join(assets, "icon.ico"),
    Buffer.concat([header, directory, ...images.map((image) => image.data)]),
  );
  copyFileSync(source, path.join(assets, "icon.png"));
  copyFileSync(source, path.join(assets, "icon-macos.png"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
