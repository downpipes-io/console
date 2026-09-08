// The canary's ailing CAUSE reaches the operator, and says something different per cause.
//
// The engine used to report one flat "unreachable" for every ailing flight, so an expired credential, a
// WORM retention refusal, a throttling store and a black-holed endpoint were the same string, leaving the
// operator to guess which one applied. The engine now classifies the fault; this file guards the console
// half: that each class produces its own honest line, that an unknown or absent cause produces NOTHING
// rather than a fabricated reason, and that the mapper is actually CALLED by the screen (a pure mapper
// nobody calls would pass every case here while the screen still showed the operator nothing).

import { readFileSync } from "node:fs";
import { ailingCauseLine } from "../src/screens/canary-copy.ts";

let failures = 0;
function ok(what: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${what}`);
}

console.log("-- every classified cause names something an operator can act on --");

// The engine's closed vocabulary: DEST_DOWN_REASONS plus the canary's own probe-mismatch, plus the legacy
// member stored history still carries.
const CAUSES = ["auth", "worm-refused", "throttled", "timeout", "network", "tls", "other", "probe-mismatch", "unreachable"] as const;

const lines = new Map<string, string>();
for (const cause of CAUSES) {
  const line = ailingCauseLine(cause);
  ok(`${cause} produces a line`, typeof line === "string" && line.length > 0);
  if (typeof line === "string") lines.set(cause, line);
}

// The whole point of the split is that the classes READ differently. Identical copy across two causes would
// pass every per-cause check above while giving the operator back the flat message this fix removed.
ok("every cause reads differently (no two share copy, which would re-collapse the split)", new Set(lines.values()).size === lines.size);

console.log("\n-- the specific classes point at the right thing --");
ok("auth names the credentials, not the network", (lines.get("auth") ?? "").toLowerCase().includes("credential"));
ok("worm-refused names the store enforcing immutability rather than a fault to repair", /object lock|retention/i.test(lines.get("worm-refused") ?? ""));
ok("tls names the certificate", /certificate/i.test(lines.get("tls") ?? ""));
ok("network names the endpoint side, since the request never arrived", /endpoint|dns|egress/i.test(lines.get("network") ?? ""));
// The most misleading case under the old vocabulary: the store ANSWERED and handed back the wrong bytes, which
// is not a "down" reason at all.
ok("probe-mismatch says the destination answered and returned different bytes", /answered/i.test(lines.get("probe-mismatch") ?? "") && /different bytes/i.test(lines.get("probe-mismatch") ?? ""));
ok("probe-mismatch never calls a reachable store unreachable", !/unreachable/i.test(lines.get("probe-mismatch") ?? ""));

console.log("\n-- an unknown or absent cause is never dressed up as a reason --");
ok("undefined yields null", ailingCauseLine(undefined) === null);
ok("an unrecognised class yields null (an engine newer than this console cannot fabricate copy)", ailingCauseLine("something-else-entirely") === null);
ok("the empty string yields null", ailingCauseLine("") === null);

console.log("\n-- and the screen actually calls it --");
{
  const sections = readFileSync(new URL("../src/screens/canary-sections.ts", import.meta.url), "utf8");
  ok("canary-sections imports the mapper", /import \{[^}]*ailingCauseLine[^}]*\} from "\.\/canary-copy\.ts"/.test(sections));
  ok("canary-sections calls it on a destination's lastCheck", /ailingCauseLine\(d\.lastCheck\?\.ailingCause\)/.test(sections));
  // Rendered, not merely computed: a note built and never appended is the same as no note.
  ok("the resulting note is appended to the status block", /status\.appendChild\(ailingNote\)/.test(sections));
}

// ---------------------------------------------------------------------------
// AND THE DEAD HALF FOLLOWS THE SAME RULE, which the comment above ailingDestNote already claimed it did
// and it did not. deadReason is nullable on the wire, and an absent one was rendered as "a byte strayed
// from the known data": the most specific and most alarming sentence this screen can say, asserted from no
// evidence, against a named destination. Rendered through the REAL renderStatusBlock and renderHistory.
// ---------------------------------------------------------------------------
console.log("\n-- an absent dead reason is not a corruption finding --");
{
  const { installDomShim, textOf } = await import("./dom-shim.ts");
  installDomShim();
  const { renderStatusBlock, renderHistory } = await import("../src/screens/canary-sections.ts");
  const { h } = await import("../src/lib/dom.ts");

  const check = (over: Record<string, unknown>): unknown => ({ at: "2026-08-05T00:00:00.000Z", ok: false, status: "dead", durationMs: 10, destinationId: "d1", runSeq: 4, aspects: [], byteDelta: null, deadReason: null, ...over });
  const dest = (over: Record<string, unknown>): unknown => ({ destinationId: "d1", label: "Primary archive", isDefault: true, status: "dead", lastRunAt: null, deadSince: null, lastCheck: check({}), ...over });
  const view = (over: Record<string, unknown>): unknown => ({
    config: { enabled: true, destinationIds: null, intervalSeconds: 3600 },
    status: "dead", lastRunAt: null, nextRunAt: null, inFlight: false, runSeq: 4,
    dests: [dest({})], history: [], allDestinations: [], destinationCount: 1, flyingToAll: true, ...over,
  });
  const engine = {} as never;
  const cb = { reload: () => {}, rerenderHero: () => {} } as never;

  const noReason = textOf(renderStatusBlock(engine, view({}) as never, h("div", {}) as never, cb));
  ok("a death the engine gave no reason for says so", /did not report why/.test(noReason));
  // The assertion is on the FABRICATED DETAIL against a NAMED DESTINATION. The headline's own over-claim
  // was a second, separate defect and is now settled below.
  ok("and it never fabricates the byte-level detail against a named destination", !/byte strayed from the known data/.test(noReason));
  ok("the destination is still named, so the fix removes a claim and not the fact", /Primary archive/.test(noReason));

  // NEGATIVE CONTROL: a reason the engine DID report is still rendered verbatim.
  const withReason = textOf(renderStatusBlock(engine, view({ dests: [dest({ lastCheck: check({ deadReason: "the read-back signature did not verify" }) })] }) as never, h("div", {}) as never, cb));
  ok("negative control: a reported reason is still rendered", /the read-back signature did not verify/.test(withReason));
  ok("negative control: and it is not replaced by the absent-reason line", !/did not report why/.test(withReason));

  // THE FLIGHT RING. A flight whose AGGREGATE is dead but whose per-destination rows carry no dead entry
  // fell through to the word "in progress": a failed verdict rendered as a benign running state.
  const deadNoRows = textOf(renderHistory(view({ history: [{ at: "2026-08-05T00:00:00.000Z", runSeq: 4, status: "dead", results: [] }] }) as never));
  ok("a dead flight with no per-destination rows is not rendered as in progress", !/in progress/.test(deadNoRows));
  ok("and it says the flight failed", /the flight failed/.test(deadNoRows));
  const pending = textOf(renderHistory(view({ history: [{ at: "2026-08-05T00:00:00.000Z", runSeq: 4, status: "pending", results: [] }] }) as never));
  ok("negative control: a genuinely pending flight still reads in progress", /in progress/.test(pending));
}

// ---------------------------------------------------------------------------
// AND THE HEADLINE ITSELF, which was the one thing the first pass deliberately left standing.
//
// CANARY_COPY.states.dead opened "A byte strayed on the last flight", which is the most specific and most
// alarming sentence this screen can say, and it is true of only some deaths. Reading the engine rather than
// the metaphor: a flight dies from decrypt-integrity (a record failed to decrypt, or bytes strayed from the
// known corpus), from read-signature (a manifest signature or record hash did not verify, OR the fail-closed
// catch for a read-back failure it could not classify), from runlog-freshness (the entry did not verify
// fresh and chained), from restore (the restore-write failed) and from restore-verify (bytes strayed after
// restore). Four of those are not a byte straying at all, and one of them exists precisely BECAUSE the cause
// is unknown.
//
// House style requires precise claims, and a metaphor is not an exemption from them. The metaphor keeps the
// label; the line states the verdict and points at the reason where the engine reported one.
// ---------------------------------------------------------------------------
console.log("\n-- the dead headline states the verdict without naming a cause --");
{
  const { CANARY_COPY } = await import("../src/screens/canary-copy.ts");
  const dead = CANARY_COPY.states.dead;
  ok("it no longer asserts that a byte strayed", !/byte strayed/i.test(dead.line));
  ok("nor any other corruption claim", !/corrupt/i.test(dead.line));
  ok("it says the flight did not verify, which is true of every death", /did not verify/i.test(dead.line));
  ok("it still says not to trust the destination for restores", /Do not trust it for real restores/.test(dead.line));
  ok("it still says the real backups were unaffected, which is the one reassurance that belongs here", /not blocked or altered/.test(dead.line));
  ok("and it points at the reported reason rather than substituting for it", /Where the engine reported which check failed/.test(dead.line));
  ok("the metaphor is kept, in the label where it costs nothing", /coalmine/.test(dead.label));

  // The intro carried the same reading: a bit straying was the only death it named.
  ok("the intro names a failed check as a death too, not only a strayed bit", /any check along that path does not verify/.test(CANARY_COPY.intro));

  // NEGATIVE CONTROLS: the other states are untouched, and the alive line's byte-for-byte claim is a claim
  // the canary genuinely earns, so removing it would be the opposite defect.
  ok("NEGATIVE CONTROL: alive still claims every byte returned exactly as sent", /every byte returned exactly as sent/.test(CANARY_COPY.states.alive.line));
  ok("NEGATIVE CONTROL: ailing still says nothing was proven either way", /nothing was proven either way/.test(CANARY_COPY.states.ailing.line));
  ok("NEGATIVE CONTROL: ailing still separates itself from detected corruption", /not detected data corruption/.test(CANARY_COPY.states.ailing.line));

  // Rendered, not merely declared: the line has to reach the hero.
  const { installDomShim: shim2, textOf: text2 } = await import("./dom-shim.ts");
  shim2();
  const { renderStatusBlock: rsb } = await import("../src/screens/canary-sections.ts");
  const { h: hh } = await import("../src/lib/dom.ts");
  const deadView = {
    config: { enabled: true, destinationIds: null, intervalSeconds: 3600 },
    status: "dead", lastRunAt: null, nextRunAt: null, inFlight: false, runSeq: 7,
    dests: [{ destinationId: "d1", label: "Primary archive", isDefault: true, status: "dead", lastRunAt: null, deadSince: null,
      lastCheck: { at: "2026-08-05T00:00:00.000Z", ok: false, status: "dead", durationMs: 10, destinationId: "d1", runSeq: 7, aspects: [], byteDelta: null, deadReason: "restore: the restore-write failed" } }],
    history: [], allDestinations: [], destinationCount: 1, flyingToAll: true,
  };
  const hero = text2(rsb({} as never, deadView as never, hh("div", {}) as never, { reload: () => {}, rerenderHero: () => {} } as never));
  ok("the rendered hero carries the new headline", /did not verify/i.test(hero));
  ok("and never the byte claim, on a death whose reason was a failed restore-write", !/byte strayed/i.test(hero));
  ok("the engine's actual reason is still shown verbatim beside it", /the restore-write failed/.test(hero));
}

if (failures > 0) {
  console.error(`\nvalidate-canary-ailing-cause: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nCANARY AILING-CAUSE VECTORS PASS");
