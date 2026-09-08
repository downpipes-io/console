// Workers-pool vitest config. This runs the console Worker's fetch
// entrypoint inside a REAL workerd isolate via @cloudflare/vitest-pool-workers, so the
// tests exercise the same runtime the Worker deploys to (not a node shim). The existing
// node validators under test/validate-*.ts are a SEPARATE, untouched suite invoked by
// `npm run validate`; this file governs only `npm run test:vitest`.
//
// vitest-pool-workers 0.16+ (vitest 4) replaced the old `defineWorkersConfig` from the
// `/config` subpath with a Vite PLUGIN, `cloudflareTest(workersOptions)`, composed into a
// plain `defineConfig` from `vitest/config`. The plugin argument is the former
// `poolOptions.workers` object.
//
// COVERAGE is configured to REPORT only (text + html + json), with NO blocking threshold,
// so adding this infrastructure cannot red CI. Raising the threshold to 85% general /
// 90%+ on crypto-bearing modules is a deferred follow-up to be done as tests are ported in.
//
// The config does NOT point `main` at src/worker.ts for an auto-loaded SELF binding,
// because the Worker's real bindings (ASSETS, ENGINE) are only present in deployment.
// The starter test imports the Worker module directly and drives its fetch handler with a
// hand-built Env, which keeps the starter green without standing up an assets server.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // No `main` and no wrangler config: the starter test invokes the imported fetch
      // handler with an explicit Env, so it needs no bound services. As more of the Worker
      // surface is covered, a wrangler block can be added here to load the real bindings.
      miniflare: {
        compatibilityDate: "2026-06-01",
      },
    }),
  ],
  test: {
    include: ["test/vitest/**/*.test.ts"],
    // Shuffle test order so no test silently depends on another's ordering.
    sequence: { shuffle: true },
    coverage: {
      // Report-only for now; NON-GATING. workerd does not support v8 coverage, so the
      // istanbul provider is used. Deferred follow-up: raise to 85% general / 90%+ on
      // crypto-bearing modules as the node validators are ported across.
      provider: "istanbul",
      reporter: ["text", "html", "json"],
      include: ["src/**/*.ts"],
      // No `thresholds` block on purpose: a failing threshold would red CI before the
      // suite is grown. Do not add one until the ported coverage clears it.
    },
  },
});
