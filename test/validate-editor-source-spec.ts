// Validate the upsert editor's and the create wizard's PURE submit decisions: the per-source-type
// SourceSpec assembly (buildSourceSpec), the RADIO-picked wizard sources' assembly (buildWizardSource:
// workers/stream/images/artifacts), and the retention validation (validateRetention). These are the
// authoritative, untestable-through-the-DOM decisions the editor makes before it POSTs to the engine, so
// a regression in a branch (a NaN keepRuns slipping through, the wrong media spec shape) would silently
// misbehave without this coverage.
//
// cf-config's own auto/manual + include selection (the original invariant: "every
// visible surface ticked" must send cfConfigMode:auto + include:[], never a redundant manual id list) now
// lives in the cf-config BULK assembly (assembleCfConfigBulk, the source-granularity audit's multi-zone +
// scope-preset fix) since cf-config moved from a single radio pick to a tick-many selection; see
// test/validate-cf-config-bulk.ts.
//
// Run with `node test/validate-editor-source-spec.ts`. Prints one line per check; exits non-zero on any
// failure. No DOM, no network, no token: every function under test is pure.

import { buildSourceSpec, type SourceSpecInputs } from "../src/screens/sources-downpipes/editor-source-spec.ts";
import { buildWizardSource } from "../src/screens/sources-downpipes/editor-wizard-downpipe.ts";
import type { WizardState } from "../src/screens/sources-downpipes/editor-wizard-source-rows.ts";
import { validateRetention } from "../src/screens/sources-downpipes/helpers.ts";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}`);
    failures++;
  }
}

// A SourceSpecInputs with sane defaults; each test overrides only the fields it exercises.
function inputs(over: Partial<SourceSpecInputs>): SourceSpecInputs {
  return {
    currentType: "kv",
    include: [],
    exclude: [],
    handoffAccountId: null,
    cfAccountId: null,
    cfZoneId: null,
    cfMode: "auto",
    cfInclude: [],
    includeContent: false,
    getSecrets: () => [],
    bindingValue: "",
    nsValue: "",
    bucketValue: "",
    d1IdValue: "",
    ...over,
  };
}

console.log("-- buildSourceSpec: per-source-type payload shape --");

{
  const r = buildSourceSpec(inputs({ currentType: "kv", bindingValue: "SRC_KV_uploads", nsValue: "ns123" }));
  const ok = "source" in r && r.source.type === "kv" && r.source.binding === "SRC_KV_uploads" && (r.source as { namespaceId?: string }).namespaceId === "ns123";
  check("kv carries the binding and a non-empty namespace override", ok);
}
{
  const r = buildSourceSpec(inputs({ currentType: "kv", bindingValue: "SRC_KV_uploads", nsValue: "" }));
  const ok = "source" in r && !("namespaceId" in r.source);
  check("kv omits namespaceId when the override is blank", ok);
}
{
  const r = buildSourceSpec(inputs({ currentType: "r2", bindingValue: "SRC_R2_assets", bucketValue: "my-bucket" }));
  const ok = "source" in r && r.source.type === "r2" && (r.source as { bucketName?: string }).bucketName === "my-bucket";
  check("r2 carries a non-empty bucket override", ok);
}
{
  const r = buildSourceSpec(inputs({ currentType: "kv", bindingValue: "   " }));
  const ok = "error" in r && r.error === "binding-required";
  check("a blank binding is rejected with binding-required", ok);
}
{
  const r = buildSourceSpec(inputs({ currentType: "kv", bindingValue: "myworker.example.workers.dev" }));
  const ok = "error" in r && r.error === "binding-host";
  check("a workers.dev host as a binding is rejected with binding-host", ok);
}
{
  const r = buildSourceSpec(inputs({ currentType: "secrets", getSecrets: () => [] }));
  const ok = "error" in r && r.error === "secrets-empty";
  check("secrets with no rows is rejected with secrets-empty", ok);
}
{
  const r = buildSourceSpec(inputs({ currentType: "secrets", getSecrets: () => [{ name: "API_KEY", binding: "SECRETS" }] }));
  const ok = "source" in r && r.source.type === "secrets" && (r.source as { secrets: unknown[] }).secrets.length === 1;
  check("secrets with rows builds a secrets spec", ok);
}
{
  // d1 records its native database id (when supplied) so a roster re-attach can rebuild the binding.
  const r = buildSourceSpec(inputs({ currentType: "d1", bindingValue: "SRC_D1_app", d1IdValue: "db-uuid-123" }));
  const ok = "source" in r && r.source.type === "d1" && (r.source as { databaseId?: string }).databaseId === "db-uuid-123";
  check("d1 carries a non-empty database id override", ok);
}
{
  const r = buildSourceSpec(inputs({ currentType: "d1", bindingValue: "SRC_D1_app", d1IdValue: "" }));
  const ok = "source" in r && !("databaseId" in r.source);
  check("d1 omits databaseId when the override is blank", ok);
}
{
  // secrets carry their Secrets Store id through getSecrets (recorded for re-attach, never a value).
  const r = buildSourceSpec(inputs({ currentType: "secrets", getSecrets: () => [{ name: "API_KEY", binding: "SECRETS", storeId: "store-abc" }] }));
  const secs = "source" in r ? (r.source as { secrets: Array<{ storeId?: string }> }).secrets : [];
  check("secrets carry the storeId from getSecrets through to the spec", secs.length === 1 && secs[0]!.storeId === "store-abc");
}

console.log("-- buildSourceSpec: stream / images / artifacts spec shape --");

for (const t of ["stream", "images", "artifacts"] as const) {
  const off = buildSourceSpec(inputs({ currentType: t, handoffAccountId: "acct1", includeContent: false }));
  const okOff = "source" in off && off.source.type === t && (off.source as { accountId?: string }).accountId === "acct1" && !("includeContent" in off.source) && !("binding" in off.source);
  check(`${t}: account-scoped, no binding, includeContent omitted when off`, okOff);

  const on = buildSourceSpec(inputs({ currentType: t, handoffAccountId: "acct1", includeContent: true }));
  const okOn = "source" in on && (on.source as { includeContent?: boolean }).includeContent === true;
  check(`${t}: includeContent: true present when content capture is on`, okOn);
}

console.log("-- buildWizardSource: the remaining RADIO types (workers/stream/images/artifacts) --");

// A minimal wizard state; each check overrides only the fields its branch reads. cf-config no
// longer reaches buildWizardSource (it is a tick-many selection assembled by
// assembleCfConfigBulk, see test/validate-cf-config-bulk.ts), so chosenType is never "cf-config"
// here -- narrowing WizType to exclude it is what makes that a compile-time guarantee, not just a
// convention.
function wizardState(over: Partial<WizardState>): WizardState {
  return {
    chosenType: "workers",
    chosenBinding: null,
    chosenAccountId: null,
    chosenWorkersAccountId: null,
    chosenStreamAccountId: null,
    chosenImagesAccountId: null,
    chosenArtifactsAccountId: null,
    cfCatalogue: [],
    chosenMulti: new Map(),
    chosenSecretsMulti: new Set(),
    cfScopePreset: null,
    chosenCfZones: new Map(),
    chosenCfAccounts: new Map(),
    cfMultiAccount: false,
    ...over,
  } as WizardState;
}

{
  const s = wizardState({ chosenType: "workers", chosenWorkersAccountId: "acct1" });
  const spec = buildWizardSource(s, "workers", false);
  check("workers: account-scoped, no binding", spec.type === "workers" && (spec as { accountId?: string }).accountId === "acct1" && !("binding" in spec));
}
{
  const off = wizardState({ chosenType: "stream", chosenStreamAccountId: "acct1" });
  const specOff = buildWizardSource(off, "stream", false);
  check("stream: includeContent omitted when the media opt-in is off", !("includeContent" in specOff));
  const on = wizardState({ chosenType: "stream", chosenStreamAccountId: "acct1" });
  const specOn = buildWizardSource(on, "stream", true);
  check("stream: includeContent:true present when the media opt-in is on", (specOn as { includeContent?: boolean }).includeContent === true);
}

console.log("-- validateRetention: NaN rejection and the at-least-one-limit guard --");

check("undefined policy is accepted (no retention set)", validateRetention(undefined) === null);
check("a policy with neither keepRuns nor keepDays is rejected (needs a limit)", validateRetention({}) !== null);
check("keepRuns NaN is rejected", validateRetention({ keepRuns: Number.NaN }) !== null);
check("keepRuns below 1 is rejected", validateRetention({ keepRuns: 0 }) !== null);
check("a fractional keepRuns is rejected (whole number required)", validateRetention({ keepRuns: 2.5 }) !== null);
check("a valid keepRuns is accepted", validateRetention({ keepRuns: 10 }) === null);
check("keepDays NaN is rejected", validateRetention({ keepDays: Number.NaN }) !== null);
check("a valid keepDays is accepted", validateRetention({ keepDays: 30 }) === null);

if (failures > 0) {
  console.log(`\nVALIDATE-EDITOR-SOURCE-SPEC: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nVALIDATE-EDITOR-SOURCE-SPEC VECTORS PASS");
