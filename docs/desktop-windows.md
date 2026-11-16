# withJZ Crew for Windows (fork)

The fork ships `apps/desktop` as **withJZ Crew**, an Electron shell that opens an existing
withJZ Crew server. The default server is `https://eu-2.tail290516.ts.net`, which is only
reachable from a device on the tailnet.

## Install

1. Run `withJZ-Crew-Setup-<version>.exe`. Check its SHA-256 against `SHA256SUMS` first
   (`Get-FileHash .\withJZ-Crew-Setup-<version>.exe -Algorithm SHA256`).
2. The installer is not code-signed yet, so Microsoft Defender SmartScreen shows "Windows
   protected your PC". Click **More info**, check the file name, then **Run anyway**.
3. The installer runs per user (no admin prompt). You can choose the folder; it adds Start menu
   and desktop shortcuts named withJZ Crew.
4. Make sure Tailscale is connected, open withJZ Crew, keep **Existing instance** with the
   prefilled address, click **Check connection**, then **Continue**, and sign in. Two-factor
   sign-in asks for the authenticator code on the server's own page, as in the browser.

Uninstall from Settings → Apps. Your sign-in data stays in `%APPDATA%\withJZ Crew` until you
delete it.

## What differs from upstream Rakazo

- **No automatic updates.** Upstream's updater reads the `elie222/rakazo` GitHub release feed,
  so it could install code that the fork never reviewed. The fork removes `electron-updater`,
  sets electron-builder `publish` to `null` (so no `app-update.yml` is written), and builds
  the update controller disabled. To update, install a newer build over the old one.
- **No managed local stack in packaged builds.** "This computer" pulls
  `ghcr.io/elie222/rakazo/*` images on mutable tags. It is hidden and refused by the main
  process unless an unpackaged run sets `RAKAZO_ENABLE_LOCAL_STACK=1` (used by the e2e suite).
  The installer no longer bundles the compose files or the web overlay.
- **Hardening on top of upstream's isolation, sandbox and permission handlers:**
  - the app window's top frame cannot leave the server origin through a server redirect
    (`will-redirect`), as well as through page navigation;
  - browser sign-in and updater IPC are only answered while the sender's top frame is on the
    server origin;
  - sign-in popups cannot open further Electron windows;
  - the setup window cannot navigate;
  - `<webview>` is blocked everywhere;
  - Electron fuses: `RunAsNode`, `NODE_OPTIONS` and `--inspect` are off, cookie encryption is
    on, and the app only loads from its integrity-checked `app.asar`.

All of these are in `apps/desktop/src/fork-config.ts`, `navigation-policy.ts` and
`main.ts`, with tests in `fork-config.test.ts`, `auto-update-disabled.test.ts`,
`hardening.test.ts`, `navigation-policy.test.ts`, `white-label.test.ts` and
`e2e/hardening.spec.ts`.

## Sign-in and the server's origin rules

The app window loads the server URL itself, so the web app's requests carry
`Origin: https://eu-2.tail290516.ts.net`, which is the server's own `WEB_ORIGIN` and passes
Better Auth's `trustedOrigins` and the API CORS check (`apps/api/src/app.ts`,
`isTrustedOrigin`). SSO sign-in runs in a same-session popup that returns to the same origin.
The loopback browser sign-in (`browser-auth.ts`) is only for model provider OAuth, never for
the server session. The main-process health probe (`POST /rpc/health`) carries no `Origin`
and needs none. No server change is needed.

## Build the installer

On Linux, inside rootless Docker, with the pinned electron-builder image:

```sh
pnpm install
pnpm --filter @rakazo/desktop build
docker run --rm \
  -v "$PWD":/project -w /project/apps/desktop \
  -v "$HOME/.cache/electron":/root/.cache/electron \
  -v "$HOME/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder@sha256:59ac6b56915ba02e4cc2d6eca9f1ed9f912b741077b7a1806f5f9519f96ed04d \
  ./node_modules/.bin/electron-builder --win nsis --x64 --publish never
```

The installer lands in `apps/desktop/out/`.

## Code signing (later)

Signing will use Azure Artifact Signing (Trusted Signing) from GitHub Actions with OIDC. The
hook is electron-builder's `win.azureSignOptions`, passed at build time so no signing settings
live in `package.json`:

```sh
electron-builder --win nsis --x64 --publish never \
  -c.forceCodeSigning=true \
  -c.win.azureSignOptions.endpoint=https://<region>.codesigning.azure.net \
  -c.win.azureSignOptions.codeSigningAccountName=<account> \
  -c.win.azureSignOptions.certificateProfileName=<profile> \
  -c.win.azureSignOptions.publisherName="<publisher CN>"
```

with `azure/login` (OIDC, no stored secret) running first. Upstream's
`.github/workflows/release-desktop.yml` still expects the GitHub update feed. Rework it
(or replace it) when signing lands, and only then consider a fork-owned update feed.
