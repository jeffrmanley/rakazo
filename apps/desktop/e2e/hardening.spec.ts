import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

// withJZ Crew: the app window must stay on its server origin even when that server
// redirects elsewhere, and privileged IPC must refuse a foreign top frame.

let app: ElectronApplication | undefined;
let userData = "";
const servers: Server[] = [];

test.beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "crew-hardening-"));
});

function launch(target: string) {
  return electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, RAKAZO_PERFORMANCE_USER_DATA: userData, RAKAZO_WEB_URL: target },
  });
}

/** Startup may briefly create hidden probe windows; wait for the one showing the target. */
async function appWindow(electronApp: ElectronApplication, prefix: string): Promise<Page> {
  await expect
    .poll(() => electronApp.windows().some((page) => page.url().startsWith(prefix)))
    .toBe(true);
  const page = electronApp.windows().find((candidate) => candidate.url().startsWith(prefix));
  if (page === undefined) throw new Error("App window is unavailable");
  return page;
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(userData, { recursive: true, force: true });
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

test("a server redirect to another origin is opened outside the app window", async () => {
  // Same host, different port: a different origin.
  const foreign = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<main>Foreign page</main>");
  });
  const server = await listen((request, response) => {
    if (request.url === "/go") {
      response.writeHead(302, { location: `${foreign}/landing` }).end();
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>crew</title><main>Crew server ready</main>");
  });

  app = await launch(`${server}/`);
  // Record instead of launching a real browser.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  const page = await appWindow(app, server);
  await expect(page.getByText("Crew server ready")).toBeVisible();

  await page.evaluate(() => {
    window.location.href = "/go";
  });

  await expect
    .poll(() => app?.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []))
    .toEqual([`${foreign}/landing`]);
  expect(new URL(page.url()).origin).toBe(server);
  await expect(page.getByText("Foreign page")).toHaveCount(0);

  // The bridge still answers on the server origin.
  const state = await page.evaluate(() =>
    (
      window as unknown as { rakazoDesktop: { update: { check(): Promise<unknown> } } }
    ).rakazoDesktop.update.check(),
  );
  expect(state).toMatchObject({ phase: "unsupported" });
});

test("browser sign-in IPC is refused from a page that is not on the server origin", async () => {
  // A data: target has an opaque origin, so it can never be a trusted app frame.
  const target = `data:text/html;charset=utf-8,${encodeURIComponent("<main>Opaque page</main>")}`;
  app = await launch(target);
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  const page = await appWindow(app, "data:");
  await expect(page.getByText("Opaque page")).toBeVisible();

  const error = await page.evaluate(async () => {
    try {
      await (
        window as unknown as { rakazoDesktop: { oauth: { open(url: string): Promise<void> } } }
      ).rakazoDesktop.oauth.open("https://provider.example/authorize");
      return null;
    } catch (caught) {
      return String(caught);
    }
  });
  expect(error).toContain("Invalid sign-in request.");
  expect(await app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toEqual([]);
});
