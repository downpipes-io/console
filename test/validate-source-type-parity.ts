// The console must not OFFER a source type the engine will REFUSE to save.
//
// WHY THIS EXISTS
// ---------------
// A source type has to clear two independent gates before a customer is protected. The console decides what
// the Add a source picker OFFERS (STORE_TYPES, plus TOKEN_SOURCE_TYPES filtered by tokenSourceOffered). The
// engine decides what a downpipe config may SELECT (SELECTABLE_SOURCE_TYPES, enforced by validateConfig).
// Nothing connected the two.
//
// The live instance was Artifact Registry. It is a Cloudflare closed beta, so it is held back in both repos,
// but by two hand-written lists that did not reference each other: ARTIFACTS_GA here, and the omission of
// "artifacts" from the engine's allow-list there. Each carried a comment telling a future engineer to re-add
// the value in that one file. Flipping ARTIFACTS_GA alone would have put Artifact Registry in the picker,
// let the operator select it, and had the engine refuse the config at save. The operator would read that as
// a broken product, and the source they believed they had protected would not be backed up.
//
// So the invariant is one-directional and strict: EVERY type the console can offer must be a type the engine
// accepts. The reverse is checked more softly (an engine type no console screen offers is a source nobody
// can reach, which is worth knowing but is not a false promise to a customer).
//
// HOW IT ASKS, AND WHY NOT BY READING THE SOURCE
// ----------------------------------------------
// It imports the engine's exported constant and CALLS its validator. It does not grep either file. That is
// deliberate and specific to this gate: the engine line that used to hold the allow-list carried a trailing
// comment naming the very value it excluded ("artifacts gated ... re-add \"artifacts\" to this array"), so a
// scanner matching source text would have found "artifacts" on the allow-list line and reported the gate
// OPEN. A scanner that reads comments as code has shipped this mistake before, and a gate that cannot see
// the gap reports a pass.
//
// The engine is resolved through the shared helper, so an override or a worktree layout is honoured the same
// way as every other cross-repo gate here. Absent an engine this SKIPS, unless REQUIRE_ENGINE=1, which is
// what `npm run validate:workspace` sets.
//
//   node test/validate-source-type-parity.ts

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { importFromEngine } from "./engine-path.ts";
import { STORE_TYPES } from "../src/lib/add-source.ts";
import { ARTIFACTS_GA, TOKEN_SOURCE_TYPES, tokenSourceOffered } from "../src/lib/token-source.ts";
import type { SourceDiscovery } from "../src/lib/api/types/sources.ts";
import { verdictReached, verdictSkipped } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

const here = `${dirname(fileURLToPath(import.meta.url))}/`;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

interface EngineConfigValidate {
  SELECTABLE_SOURCE_TYPES: readonly string[];
  SELECTABLE_TOKEN_SOURCE_TYPES: readonly string[];
  validateConfig: (c: unknown) => void;
}

const mod = await importFromEngine<EngineConfigValidate>(here, "src/sched/config-validate.ts");
if (mod === null) {
  // DECLARED, not silent: measured at exit 0 with no parity check run, indistinguishable in the log from a
  // pass. The exit code stays 0 because a console-only clone has no engine; the skip is now greppable.
  verdictSkipped("SOURCE TYPE PARITY: no engine checkout reachable");
  process.exit(0);
}
const { SELECTABLE_SOURCE_TYPES, SELECTABLE_TOKEN_SOURCE_TYPES, validateConfig } = mod;

// engineAccepts asks the engine's own validator, rather than reading its list, so the two ways of knowing
// have to agree before anything below is trusted. The probe config is otherwise VALID: validateSource runs
// LAST, so a config that trips an earlier section throws a message that is not the type refusal and would
// read as "accepted" for every type alike.
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
function engineAccepts(t: string): boolean {
  const source: Record<string, unknown> = { type: t, include: [], exclude: [] };
  // A bound source is identified by its binding; a token source by an account id. Supply both: the validator
  // reads whichever its branch for that type requires, and neither is rejected for being present.
  source.binding = "KV_probe";
  source.accountId = ACCOUNT_ID;
  try {
    validateConfig({ id: "dp-parity-probe", name: "parity probe", cadenceSeconds: 3600, enabled: true, source });
    return true;
  } catch (e) {
    return !/^source\.type must be/.test(e instanceof Error ? e.message : String(e));
  }
}

console.log("-- the probe discriminates before it is trusted --");
ok("engineAccepts reads a known-good type as accepted", engineAccepts("kv") === true);
ok("engineAccepts reads a type no build has ever had as refused", engineAccepts("no-such-source-type") === false);
// The imported list and the live validator are two ways of knowing the same fact. If they disagree, the
// constant has stopped being the thing the validator enforces, and every verdict below is unfounded.
const listVsValidator = SELECTABLE_SOURCE_TYPES.filter((t) => !engineAccepts(t));
ok("every type on the engine's exported list is accepted by its own validator", listVsValidator.length === 0);
ok("the engine's list is not empty (an empty list would pass every check below vacuously)", SELECTABLE_SOURCE_TYPES.length > 0);

console.log("-- the console cannot offer what the engine refuses --");
// A discovery response that advertises EVERY token source, which is the most permissive engine answer the
// picker can receive. Anything the console still offers here, it can offer in production.
const allAdvertised: SourceDiscovery = {
  cfConfigSurfaces: [{ id: "zone-settings" }],
  workersSupported: true,
  streamSupported: true,
  imagesSupported: true,
  artifactsSupported: true,
} as unknown as SourceDiscovery;
const offeredTokenTypes = TOKEN_SOURCE_TYPES.filter((t) => tokenSourceOffered(allAdvertised)[t]);
const consoleOffers = [...STORE_TYPES, ...offeredTokenTypes];
ok("the console offers at least one type (an empty picker would pass this vacuously)", consoleOffers.length > 0);
for (const t of consoleOffers) {
  ok(`the engine accepts "${t}", which the console offers`, engineAccepts(t));
}

console.log("-- the artifacts beta gate opens on both sides or neither --");
const engineHasArtifacts = engineAccepts("artifacts");
ok("ARTIFACTS_GA is not true while the engine still refuses the type", !(ARTIFACTS_GA && !engineHasArtifacts));
// The other direction is not a customer-facing fault, so it is stated rather than failed on: an engine that
// accepts artifacts while ARTIFACTS_GA is false simply means the console has not caught up yet.
if (engineHasArtifacts && !ARTIFACTS_GA) {
  console.log("  note the engine now accepts artifacts; flip ARTIFACTS_GA in src/lib/token-source.ts to offer it");
}

console.log("-- the engine's token-source subset matches what the console can offer --");
// SELECTABLE_TOKEN_SOURCE_TYPES is what the engine's Sources screen allow-list derives from. A type the
// console offers that is not in it can be selected in a downpipe but never "added" on the Sources screen.
for (const t of offeredTokenTypes) {
  ok(`"${t}" is addable on the engine's Sources screen as well as selectable`, SELECTABLE_TOKEN_SOURCE_TYPES.includes(t));
}

console.log("-- every engine type is reachable from some console picker --");
// The softer direction: an engine type no picker offers is a source a customer cannot protect through the
// console, which the no-customer-CLI rule makes unreachable full stop.
const unreachable = SELECTABLE_SOURCE_TYPES.filter((t) => !consoleOffers.includes(t as never));
ok(`no engine-selectable type is missing from the console picker (missing: ${unreachable.join(", ") || "none"})`, unreachable.length === 0);

console.log(failures === 0 ? "\nSOURCE TYPE PARITY PASS" : `\n${failures} FAILURE(S)`);
verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
if (failures > 0) process.exit(1);
