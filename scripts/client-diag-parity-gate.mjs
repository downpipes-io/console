#!/usr/bin/env node
// Client-diagnostics vocabulary drift gate: the console and the engine hold TWIN closed vocabularies, and they
// must not diverge.
//
// WHY THIS EXISTS. The console's error ring rides INSIDE the support pack the customer generates. On arrival the
// engine RE-VALIDATES every row against its own copy of the vocabulary (projectClientDiagnostics,
// src/admin/client-diag-receive.ts) and DROPS any member it does not recognise. That re-validation is correct:
// the ring is the only client-asserted input in the pack, so the engine must never trust it.
//
// But it means a console that emits a screen or kind the engine does not know does not fail loudly. The row is
// silently discarded, and the browser evidence for that screen simply never appears in the pack. The customer
// generated the pack, the console recorded the fault, and support sees nothing.
//
// This is the drift class that can leave a diagnostics consumer badly behind its engine while its test suite
// stays fully green. It is caught here BEFORE it can happen, rather than after: adding a screen to the console
// vocabulary without adding it to the engine's is the natural, easy mistake, and it is silent.
//
// Direction matters. A member the CONSOLE emits and the ENGINE lacks is a FAILURE (evidence vanishes). A member
// the ENGINE admits and the console never emits is merely unused, and is reported as a note, not a failure.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// The engine repo: an explicit override, then the unified worktree, then the merged repo. The worktree wins
// while a build is in flight, because it IS the engine that will ship.
// The cast is comment-only: `.filter(Boolean)` drops the undefined DOWNPIPES_ENGINE at runtime but does not
// narrow the type.
const CANDIDATES = /** @type {string[]} */ ([
  process.env.DOWNPIPES_ENGINE,
  resolve(HERE, "../../support-unified-engine"),
  resolve(HERE, "../../support-pack-engine"),
  resolve(HERE, "../../engine"),
  resolve(HERE, "../../../engine"),
].filter(Boolean));

const ENGINE_VOCAB = "src/admin/client-diag-vocab.ts";
const engineRoot = CANDIDATES.find((c) => existsSync(resolve(c, ENGINE_VOCAB)));
if (engineRoot === undefined) {
  console.error("CLIENT-DIAG DRIFT GATE: FAIL — cannot locate the engine, so the twin vocabularies cannot be compared.");
  console.error("  Set DOWNPIPES_ENGINE=/path/to/engine, or check the engine out beside this repo.");
  console.error("  This FAILS rather than skips on purpose: a gate that quietly opts out when it cannot check");
  console.error("  reads as a pass, which is the failure it exists to prevent.");
  // Exit 2, not 1: 1 is reserved for a real vocabulary drop below.
  process.exit(2);
}

// A resolved engine that is merely BEHIND its own origin/main compares against a vocabulary that has since
// moved and reports it healthy -- the same failure shape verify-citations.mjs can hit against a stale
// engine checkout. No fetch, so unknown freshness (no origin/main ref) is not judged either way.
// CLIENT_DIAG_ALLOW_STALE=1 overrides.
if (process.env.CLIENT_DIAG_ALLOW_STALE !== "1") {
  /** @type {number | null} */
  let behind = null;
  try {
    behind = Number(execFileSync("git", ["-C", engineRoot, "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* unknown freshness, nothing to conclude */ }
  if (Number.isFinite(behind) && /** @type {number} */ (behind) > 0) {
    console.error(`CLIENT-DIAG DRIFT GATE: FAIL, the engine at ${engineRoot} is ${behind} commit(s) behind its own origin/main.`);
    console.error("  Every member below would be graded against a vocabulary that has since moved, and reported safe.");
    console.error("  Update the checkout, or set CLIENT_DIAG_ALLOW_STALE=1 if an old tree is deliberate.");
    process.exit(2);
  }
}

console.log(`CLIENT-DIAG DRIFT GATE: comparing against engine at ${engineRoot}`);

const consoleVocab = await import(resolve(HERE, "../src/lib/client-diag/vocab.ts"));
const engineVocab = await import(resolve(engineRoot, ENGINE_VOCAB));

const VOCABULARIES = [
  "CLIENT_DIAG_KINDS",
  "CLIENT_DIAG_SCREENS",
  "CLIENT_DIAG_HTTP_CLASSES",
  "CLIENT_DIAG_FAULT_CLASSES",
  "CLIENT_DIAG_DRIFT_CLASSES",
  "CLIENT_DIAG_REASON_CLASSES",
  "CLIENT_DIAG_APPLY_CLASSES",
  "CLIENT_DIAG_CAPABILITIES",
  "CLIENT_DIAG_SURFACES",
  "CLIENT_DIAG_CAPABILITY_OUTCOMES",
  "CLIENT_DIAG_BOOT_CLASSES",
  "CLIENT_DIAG_BUILD_CHECK_CLASSES",
  "CLIENT_DIAG_ROLLBACK_CLASSES",
  "CLIENT_DIAG_GATE_BLOCK_CLASSES",
  "CLIENT_DIAG_FIELD_CLASSES",
  "CLIENT_DIAG_ANOMALIES",
  "CLIENT_DIAG_ERROR_CLASSES",
  "CLIENT_DIAG_FAULT_SOURCES",
  "CLIENT_DIAG_TRANSPORT_CLASSES",
  "CLIENT_DIAG_CALL_CLASSES",
  "CLIENT_DIAG_ONBOARDING_STEPS",
  "CLIENT_DIAG_ONBOARDING_OUTCOMES",
  "CLIENT_DIAG_DISCOVERY_OUTCOMES",
  "CLIENT_DIAG_CLAIM_RESULTS",
  // These four close a silent-drift hole this gate exists to catch: a console op the engine does not admit
  // would drop every admin-write row carrying it, and the gate would report all-green without checking them.
  "CLIENT_DIAG_ADMIN_OPS",
  "CLIENT_DIAG_WRITE_OUTCOMES",
  "CLIENT_DIAG_RECOVERY_OPS",
  "CLIENT_DIAG_RECOVERY_CODES",
  "CLIENT_DIAG_INTENT_CLASSES",
  "CLIENT_DIAG_PROBE_SURFACES",
  "CLIENT_DIAG_PROBE_OUTCOMES",
  "CLIENT_DIAG_FORM_FIELDS",
  "CLIENT_DIAG_REJECT_OUTCOMES",
  "CLIENT_DIAG_CATALOGUE_CLASSES",
  "CLIENT_DIAG_FEATURE_CLASSES",
  "CLIENT_DIAG_FEATURE_OUTCOMES",
  "CLIENT_DIAG_GOV_GATES",
  "CLIENT_DIAG_SKEW_CLASSES",
  "CLIENT_DIAG_BULK_ACTIONS",
  "CLIENT_DIAG_MATERIAL_CLASSES",
  "CLIENT_DIAG_CONTRACT_CLASSES",
  "CLIENT_DIAG_FIELD_FAMILIES",
  "CLIENT_DIAG_DRILL_ABORTS",
  "CLIENT_DIAG_DRILL_FACTS",
];

let failed = 0;
for (const name of VOCABULARIES) {
  const fromConsole = consoleVocab[name];
  const fromEngine = engineVocab[name];
  if (!Array.isArray(fromConsole) || !Array.isArray(fromEngine)) {
    failed += 1;
    console.error(`  FAIL ${name}: missing from ${!Array.isArray(fromConsole) ? "the console" : "the engine"}.`);
    continue;
  }
  const admitted = new Set(fromEngine);
  const dropped = [...new Set(fromConsole)].filter((m) => !admitted.has(m));
  const unused = [...new Set(fromEngine)].filter((m) => !new Set(fromConsole).has(m));

  if (dropped.length > 0) {
    failed += 1;
    console.error(`  FAIL ${name}: the console emits ${dropped.length} member(s) the ENGINE DROPS on arrival.`);
    console.error("       Every row carrying one is silently discarded: the console recorded the fault, the");
    console.error("       customer sent the pack, and support sees nothing. Add them to the engine's vocabulary.");
    for (const m of dropped) console.error(`         + ${m}`);
    continue;
  }
  const note = unused.length > 0 ? `  (engine also admits ${unused.length} the console never emits: harmless)` : "";
  console.log(`  ok   ${name}: the engine admits all ${new Set(fromConsole).size} members the console emits${note}`);
}

// The row caps must match too: a console that keeps more rows than the engine will accept has its overflow
// silently truncated at the boundary, which under-reports the very burst that made the customer file the ticket.
for (const cap of ["CLIENT_DIAG_PER_KIND_ROW_CAP", "CLIENT_DIAG_GLOBAL_ROW_CAP"]) {
  const c = consoleVocab[cap];
  const e = engineVocab[cap];
  if (c === undefined || e === undefined) continue;
  if (c > e) {
    failed += 1;
    console.error(`  FAIL ${cap}: the console keeps ${c} rows but the engine accepts only ${e}.`);
    console.error("       The overflow is truncated at the boundary, under-reporting the burst it was recording.");
  } else {
    console.log(`  ok   ${cap}: console ${c} <= engine ${e}`);
  }
}

if (failed > 0) {
  console.error("\nCLIENT-DIAG DRIFT GATE: FAIL — the console is emitting evidence the engine will throw away.");
  process.exit(1);
}
console.log("CLIENT-DIAG DRIFT GATE: PASS");
