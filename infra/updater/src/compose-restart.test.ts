import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  restart?: string;
  command?: unknown;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function loadCompose(rel: string) {
  return parse(readFileSync(path.resolve(repoRoot, rel), "utf8")) as {
    services: Record<string, ComposeService>;
  };
}

// One-shot helpers that must exit and stay down (`depends_on: service_completed_successfully`).
const ONE_SHOT = new Set(["computer", "data-init"]);

describe("docker-compose.yml restart policy", () => {
  const compose = loadCompose("infra/compose/docker-compose.yml");

  it("restarts every long-running service after a crash or a host reboot", () => {
    // A service without a policy stays down after a reboot: on 2026-11-17 web-app did, and every
    // page answered 502 while /health (api) still passed.
    const longRunning = Object.keys(compose.services).filter((name) => !ONE_SHOT.has(name));
    expect(longRunning).toEqual(
      expect.arrayContaining(["postgres", "supervisor", "api", "worker", "web", "web-app"]),
    );
    for (const name of longRunning) {
      expect({ name, restart: compose.services[name]?.restart }).toEqual({
        name,
        restart: "unless-stopped",
      });
    }
  });

  it("never restarts the one-shot helpers", () => {
    for (const name of ONE_SHOT) {
      expect(compose.services[name], name).toBeDefined();
      expect({ name, restart: compose.services[name]?.restart }).toEqual({ name, restart: "no" });
    }
  });
});
