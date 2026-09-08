// A cf-config skip must say WHY, not just that it happened.
//
// THE GAP. The console's mirror of the engine's `configApplied` carried `{ surface, applied, skipped }`
// and dropped `skipReasonCounts` at the type boundary, so the receipt could show that a Cloudflare-config
// surface skipped items and could not show the reason. The bare integer cannot tell "your plan caps DNS
// records" from "the restore token lacks the edit scope for this surface" from "the snapshot item is
// malformed", which are three tickets with three different remedies. It matters more now that the engine
// reports a too-narrow token by name and folds the class tally inside the hashed and signed core of the
// receipt.
//
// TWO PROPERTIES ARE LOAD-BEARING AND BOTH ARE ASSERTED BELOW.
//
// The engine deliberately made its safety property INDEPENDENT OF THE CLASSIFIER: a real refusal worded so
// that it falls through to `other` still fails the apply, so nothing rests on a pattern matching
// Cloudflare's wording. Whatever the console renders has to degrade the same way, so `other` is rendered,
// and so is a class a newer engine sends that this console's union does not carry. A skip the screen drops
// because it matched nothing is the silence this whole tally exists to end.
//
// And `entitlement` is NOT a problem. The account's plan does not carry the surface, so there is no item to
// restore and nothing to fix, which is why the engine's own predicate excludes exactly that member from the
// classes that fail an apply. A customer seeing it must not be told to widen a token.
//
// House style: Australian English, no em dashes, no rule-of-three, no AI attribution.

import { installDomShim, textOf } from "./dom-shim.ts";
installDomShim();

import { cfSkipEntries, cfSkipIsBenign, cfSkipLine, cfSkipsNeedAction } from "../src/screens/restore-flow/cf-skip-copy.ts";
import { renderReceipt } from "../src/screens/restore-flow/receipt.ts";
import type { CfConfigSkipClass, RestoreResult } from "../src/api.ts";

let failures = 0;
function ok(what: string, cond: boolean): void {
  console.log(cond ? `  ok   ${what}` : `  FAIL ${what}`);
  if (!cond) failures++;
}

// The engine's closed vocabulary, mirrored here so a member added to one side and forgotten on the other
// shows up as a missing line rather than as silence on a receipt.
const CLASSES: readonly CfConfigSkipClass[] = ["auth", "entitlement", "quota", "validation", "conflict", "no-live-id", "no-live-phase", "live-only-rules", "rate-limited", "api-unavailable", "other"];

function result(over: Partial<RestoreResult>): RestoreResult {
  return {
    ok: true, runId: "r-1", mode: "applied", recordsVerified: 4, recordsRestored: 4, bytesRestored: 1024,
    isLatest: true, failures: [], ...over,
  } as RestoreResult;
}
const receiptText = (res: RestoreResult): string =>
  textOf(renderReceipt(res, "owner@example.com", null, null, () => {}) as never);

console.log("-- every class the engine can send has a line, and they read differently --");
{
  const lines = new Map<string, string>();
  for (const cls of CLASSES) lines.set(cls, cfSkipLine(cls));
  ok("every class produces a line", [...lines.values()].every((l) => l.length > 0));
  // Shared copy across two classes would pass every per-class check while giving back the bare integer's
  // single undifferentiated meaning, which is the defect.
  ok("no two classes share copy", new Set(lines.values()).size === lines.size);

  ok("auth names the token and the scope, which is the remedy that just became reportable", /token/.test(lines.get("auth") ?? "") && /edit scope/.test(lines.get("auth") ?? ""));
  ok("quota names the plan limit rather than the token", /plan limit/.test(lines.get("quota") ?? "") && !/token/.test(lines.get("quota") ?? ""));
  ok("validation sends the customer to support with the run id, not to a token", /run id/.test(lines.get("validation") ?? "") && !/token/.test(lines.get("validation") ?? ""));
  ok("conflict names the live item in the way", /already occupies/.test(lines.get("conflict") ?? ""));
}

console.log("\n-- the benign class is worded as benign and never sends anyone to widen a token --");
{
  const line = cfSkipLine("entitlement");
  ok("entitlement is the only benign class, mirroring the engine's own predicate", cfSkipIsBenign("entitlement"));
  for (const cls of CLASSES.filter((c) => c !== "entitlement")) {
    ok(`NEGATIVE CONTROL: ${cls} is not treated as benign`, !cfSkipIsBenign(cls));
  }
  ok("its copy says nothing is wrong", /Nothing is wrong/.test(line));
  ok("and it does not mention a token, a scope or a plan limit", !/token/i.test(line) && !/scope/i.test(line) && !/plan limit/i.test(line));

  // The heading question: a surface that skipped ONLY on entitlement fully applied with respect to the
  // account, and flagging it would train an operator to stop reading a clean result.
  ok("a surface skipping only on entitlement needs no action", !cfSkipsNeedAction({ entitlement: 3 }));
  ok("NEGATIVE CONTROL: one alongside a real refusal does need action", cfSkipsNeedAction({ entitlement: 3, auth: 1 }));
  // And it sorts last, so it never sits above the refusal that does need doing something about.
  ok("and it is ordered after the refusal that needs an action", cfSkipEntries({ entitlement: 3, auth: 1 })[0]?.[0] === "auth");
}

console.log("\n-- an unclassified refusal is named, never dropped --");
{
  // The engine's safety property does not rest on its classifier, so neither does this.
  ok("other has its own line rather than falling through to nothing", cfSkipLine("other").length > 0);
  ok("and it says the console does not recognise the reason rather than inventing one", /does not recognise/.test(cfSkipLine("other")));
  ok("other is not benign, because the item is still not in the account", !cfSkipIsBenign("other"));

  // A class a NEWER engine sends. Dropping it would hide a real refusal behind a version difference.
  const future = cfSkipLine("some-future-class");
  ok("a class this console does not carry still gets a line", future.length > 0);
  ok("and the line says the count is real", /count is real/.test(future));
  ok("it is counted rather than filtered out", cfSkipEntries({ "some-future-class": 2 } as never).length === 1);
  ok("and it is treated as needing action, because nothing says otherwise", cfSkipsNeedAction({ "some-future-class": 2 } as never));
}

// No block braces here, unlike the sections around it: every other section scopes a `const`, and
// this one declares nothing, so biome's noUselessLoneBlockStatements rightly rejects the braces.
console.log("\n-- zero and nonsense counts render nothing, so a clean surface stays clean --");
ok("a zero count is dropped", cfSkipEntries({ auth: 0 }).length === 0);
ok("a negative count is dropped", cfSkipEntries({ auth: -1 }).length === 0);
ok("a non-finite count is dropped rather than rendered as NaN", cfSkipEntries({ auth: Number.NaN }).length === 0);
ok("an absent map yields nothing", cfSkipEntries(undefined).length === 0);
ok("and needs no action", !cfSkipsNeedAction(undefined) && !cfSkipsNeedAction({ auth: 0 }));

console.log("\n-- and it reaches the receipt the customer reads --");
{
  const text = receiptText(result({
    configApplied: [{ surface: "dns_records", applied: 12, skipped: 3, skipReasonCounts: { auth: 2, entitlement: 1 } }],
  }));
  ok("the surface and its counts still render", /dns_records/.test(text) && /12 applied/.test(text) && /3 skipped/.test(text));
  ok("the token refusal is named with its count", /2 items/.test(text) && /edit scope/.test(text));
  ok("the benign one is named with its own count and its own words", /1 item:/.test(text) && /Nothing is wrong/.test(text));
  ok("Cloudflare's own message is nowhere on the receipt, because the console never receives it", !/cloudflare api error|code: ?\d{4,}/i.test(text));

  // NEGATIVE CONTROL: a surface that skipped nothing gains no reason lines, and an engine that sends no
  // tally at all (an older one) renders exactly what it used to.
  const clean = receiptText(result({ configApplied: [{ surface: "waf_rules", applied: 5, skipped: 0 }] }));
  ok("NEGATIVE CONTROL: a surface with no skips shows no reason line", /waf_rules/.test(clean) && !/edit scope/.test(clean) && !/Nothing is wrong/.test(clean));
  const noTally = receiptText(result({ configApplied: [{ surface: "waf_rules", applied: 5, skipped: 2 }] }));
  ok("NEGATIVE CONTROL: a skip count with no tally still shows the count", /2 skipped/.test(noTally));
  ok("NEGATIVE CONTROL: and fabricates no reason for it", !/edit scope/.test(noTally) && !/does not recognise/.test(noTally));
}

console.log("");
if (failures > 0) {
  console.error(`validate-cf-skip-reasons: ${failures} FAILED`);
  process.exit(1);
}
console.log("CF-CONFIG SKIP REASONS REACH THE RECEIPT");
