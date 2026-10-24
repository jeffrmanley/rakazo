FROM node:22.23.4-bookworm@sha256:2bd396628eceb5c999a6e43731fab69d5fb98b94ba9d9d90b5f64575c5178765 AS app
RUN corepack enable
WORKDIR /app
# Normalize modes: a restrictive host umask (e.g. 077 on hardened hosts) would otherwise
# leave the copied tree unreadable to USER node at runtime.
COPY --chmod=755 . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @rakazo/db generate
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
RUN install -d -m 750 -o node -g node /data /app/apps/web/node_modules/.vite-temp
ARG GIT_SHA
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
EXPOSE 3100 5173 7091
USER node
CMD ["pnpm", "--filter", "@rakazo/api", "start"]

# The hardened web front end (`--target web`): Caddy serves the built SPA with security headers
# and proxies the API and the Node routes (see infra/compose/Caddyfile.web). Official image,
# pinned by digest; `apk upgrade` picks up Alpine fixes published after the image was built.
# It listens on 5173 as an unprivileged user, so the binary's cap_net_bind_service file capability
# is dropped: a binary with file capabilities cannot run under cap_drop ALL + no-new-privileges.
FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f AS web
RUN apk upgrade --no-cache && setcap -r /usr/bin/caddy && \
  install -d -m 700 -o 65534 -g 65534 /data/caddy /config/caddy
COPY --from=app /app/apps/web/dist /srv
COPY infra/compose/Caddyfile.web /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
USER 65534:65534
EXPOSE 5173

# The default target stays the application image (api, worker, and the Node side of the web).
FROM app
