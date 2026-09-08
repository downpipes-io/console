// Validate the cost ESTIMATION library (src/lib/cost-model.ts) with hand-computed
// cross-checks. Run with `node test/validate-cost-model.ts` after `npm install`. Prints a
// line per check and exits non-zero on any failure, matching the validator style.
//
// THE HONEST GROWTH MODEL IS THE LOAD-BEARING PIN HERE: the live engine's content-address
// key derives from the per-run master, so dedup applies only WITHIN a run and every run
// stores a FULL snapshot. The DEFAULT projection must therefore be per-run snapshot
// accumulation (runs per period x archive bytes per run), and churn must NOT move it. The
// spec's churn-driven maths (design/02-areas/cost-calculator/spec.md section 2) is retained
// as the EXPLICITLY-SELECTED "churn-dedup" growth model only (cross-run dedup is a recorded
// SPEC-level decision, not current behaviour), and its maths is pinned under that label.
//
// Coverage: the default snapshot model (per-run growth = full stored snapshot; churn
// invariance; the snapshot retained steady state), the labelled churn-dedup model (the
// spec's maths, unchanged under its flag), both storage regimes, the cadence conversions,
// the retention-window-to-runs bound, the zero-egress R2 path, the cost split (storage /
// writes / reads / egress), the projection (both regimes, cumulative), the marginal
// per-run / per-restore / per-drill views, the retention saving, the sensitivity sweeps,
// the observed-seed derivation (per-run bytes from REAL run history), and the edges. Every
// numeric assertion is cross-checked against a value computed by hand here, independent of
// the library internals.
//
// This file is a THIN ORCHESTRATOR: the assertions live in cohesive sibling modules
// (validate-cost-model-<area>.ts), each exporting a `run(harness)` that reports through the
// SAME shared harness. The groups are called in the original order so the full suite still
// runs in one `node test/validate-cost-model.ts` invocation.

import { makeHarness } from "./validate-cost-model-shared.ts";
import { run as runPresets } from "./validate-cost-model-presets.ts";
import { run as runSnapshot } from "./validate-cost-model-snapshot.ts";
import { run as runChurnDedup } from "./validate-cost-model-churn-dedup.ts";
import { run as runObservedSeed } from "./validate-cost-model-observed-seed.ts";
import { run as runEdges } from "./validate-cost-model-edges.ts";
import { run as runPlatform } from "./validate-cost-model-platform.ts";

function main(): void {
  const h = makeHarness();

  runPresets(h);
  runSnapshot(h);
  runChurnDedup(h);
  runObservedSeed(h);
  runEdges(h);
  runPlatform(h);

  console.log(h.failures === 0 ? "\nALL COST-MODEL VECTORS PASS" : `\n${h.failures} FAILURE(S)`);
  if (h.failures > 0) process.exit(1);
}

main();
