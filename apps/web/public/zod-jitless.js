// zod compiles object parsers with `new Function` when it can, probing for that as soon as the
// first object schema exists. Under the Content-Security-Policy (script-src 'self') the probe is a
// reported violation on every page; parsing without the JIT is correct, only slightly slower.
// zod reads its config from this global (shared by every copy of zod on the page), and this
// classic script runs before any module, so no schema is built first.
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, {
  jitless: true,
});
