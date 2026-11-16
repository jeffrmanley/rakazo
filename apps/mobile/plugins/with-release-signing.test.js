import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReleaseSigning } from "./with-release-signing.js";

const require = createRequire(import.meta.url);
const expoTemplateTgz = join(dirname(require.resolve("expo/package.json")), "template.tgz");
// The pinned Expo template, so a template change fails here instead of at prebuild.
const TEMPLATE = execFileSync(
  "tar",
  ["-xOf", expoTemplateTgz, "package/android/app/build.gradle"],
  {
    encoding: "utf8",
  },
);

function releaseBlock(gradle) {
  return /buildTypes \{[\s\S]*?release \{([\s\S]*?)\n {8}\}/.exec(gradle)?.[1] ?? "";
}

describe("applyReleaseSigning", () => {
  it("signs release builds with the upload key, never the template's debug key", () => {
    const result = applyReleaseSigning(TEMPLATE);
    expect(releaseBlock(TEMPLATE)).toContain("signingConfig signingConfigs.debug");
    expect(releaseBlock(result)).toContain("signingConfig signingConfigs.crewUpload");
    expect(releaseBlock(result)).not.toContain("signingConfigs.debug");
    // Debug builds keep the debug key.
    expect(result).toMatch(/debug \{\s*signingConfig signingConfigs\.debug/);
  });

  it("reads only paths from the environment and keeps every secret out of the file", () => {
    const result = applyReleaseSigning(TEMPLATE);
    expect(result).toContain('System.getenv("CREW_UPLOAD_STORE_FILE")');
    expect(result).toContain('System.getenv("CREW_UPLOAD_STORE_PASSWORD_FILE")');
    expect(result).toContain("new File(crewPassPath).text.trim()");
    // The only literal password is the template's public debug one.
    expect(result.match(/storePassword\s+['"][^'"]*['"]/g)).toEqual(["storePassword 'android'"]);
  });

  it("is idempotent and refuses a template it does not recognise", () => {
    const once = applyReleaseSigning(TEMPLATE);
    expect(applyReleaseSigning(once)).toBe(once);
    expect(() => applyReleaseSigning("android {}")).toThrow("template changed");
  });
});
