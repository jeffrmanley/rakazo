FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches patches
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/logging packages/logging
COPY infra/sandboxes/supervisor infra/sandboxes/supervisor
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@rakazo/sandbox-supervisor..."
WORKDIR /app/infra/sandboxes/supervisor
# Runs as the image's root because it drives the Docker socket; under rootless Docker that is the
# unprivileged host user. Narrowing its Docker access is hardening phase 2.
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
