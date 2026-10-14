# Compose stack end-to-end test

Runs the production compose file (plus an offline echo model) on ports that don't collide with a
deployment on the same host, then drives it with Playwright (`apps/web/e2e/stack-smoke.spec.ts`)
and checks the audit chain, including a deliberately tampered row.

```bash
cp .env.example .env   # fill the secrets; see below
infra/compose/e2e/run.sh            # build, run, tear down
KEEP=1 SKIP_BUILD=1 infra/compose/e2e/run.sh   # reuse images, keep the stack up
```

`.env` needs `BETTER_AUTH_URL` and `WEB_ORIGIN` set to `http://127.0.0.1:15173`, plus
`EXT_AUDIT_LOG=1` (and the other `EXT_*` flags under test). Ports: web 15173, api 13100, echo
model 18080 (`E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_MODEL_PORT`). The echo model answers
`echo: <last user line>` and reports a fixed cost per call (`ECHO_MODEL_COST_USD`, default 0.5)
so budget metering has real numbers. Test-only: never deploy it.
