#!/usr/bin/env bash
# Build and start the production compose stack with an offline echo model on
# non-default ports, run the stack Playwright suite against it, verify the audit
# chain inside the api container, then (unless KEEP=1) tear the stack down.
# Needs a repo-root .env (see .env.example); BETTER_AUTH_URL and WEB_ORIGIN must
# point at http://127.0.0.1:${E2E_WEB_PORT:-15173}.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
export E2E_PROJECT="${E2E_PROJECT:-stack-e2e}"
export E2E_WEB_PORT="${E2E_WEB_PORT:-15173}"
if [[ -z "${E2E_DOCKER_SOCKET:-}" ]]; then
  if [[ "${DOCKER_HOST:-}" == unix://* ]]; then export E2E_DOCKER_SOCKET="${DOCKER_HOST#unix://}"
  else export E2E_DOCKER_SOCKET=/var/run/docker.sock; fi
fi
compose=(docker compose --env-file .env -f infra/compose/docker-compose.yml -f infra/compose/e2e/docker-compose.e2e.yml)

mkdir -p data
if [[ "${SKIP_BUILD:-0}" != 1 ]]; then "${compose[@]}" build; fi
"${compose[@]}" up -d
cleanup() { if [[ "${KEEP:-0}" != 1 ]]; then "${compose[@]}" down -v; fi; }
trap cleanup EXIT

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${E2E_WEB_PORT}/" >/dev/null 2>&1; then break; fi
  sleep 2
done

# The model guard treats non-IP hostnames as public, so use the echo model's
# private compose-network address (allowed without any override).
model_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$("${compose[@]}" ps -q echo-model)")"
# The sign-up heading names the configured brand.
PUBLIC_BRAND_NAME="$(grep -E '^PUBLIC_BRAND_NAME=' .env | cut -d= -f2- || true)"
export PUBLIC_BRAND_NAME
STACK_MODEL_URL="http://${model_ip}:8080/v1" \
STACK_E2E=1 PLAYWRIGHT_BASE_URL="http://127.0.0.1:${E2E_WEB_PORT}" AGENT_RUNTIME=pi \
  pnpm --filter @rakazo/web exec playwright test e2e/stack-smoke.spec.ts "$@"

"${compose[@]}" exec -T api pnpm --filter @rakazo/api audit:verify

# Tamper evidence: a superuser bypassing the append-only trigger must be caught.
pg_user="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)"; pg_user="${pg_user:-rakazo}"
pg_db="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)"; pg_db="${pg_db:-rakazo}"
tampered="$("${compose[@]}" exec -T postgres psql -U "$pg_user" -d "$pg_db" -At -v ON_ERROR_STOP=1 \
  -c "set session_replication_role = replica" \
  -c "update ext_audit_events set summary = summary || ' (edited)' where id = (select id from ext_audit_events order by at desc limit 1) returning id" | head -1)"
if "${compose[@]}" exec -T api pnpm --filter @rakazo/api audit:verify >/tmp/stack-e2e-verify.log 2>&1; then
  echo "FAIL: audit verifier passed a tampered chain" >&2; exit 1
fi
grep -q "BREAK.*${tampered}" /tmp/stack-e2e-verify.log || { echo "FAIL: verifier did not name ${tampered}" >&2; exit 1; }
echo "OK: tampered audit event ${tampered} detected"
