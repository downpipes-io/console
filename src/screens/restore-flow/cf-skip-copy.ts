// What a cf-config SKIP means, in words a customer can act on.
//
// THE GAP THIS CLOSES. The restore receipt could say a Cloudflare-config surface skipped items and could
// not say why: the console's mirror of `configApplied` carried the bare `skipped` integer and dropped the
// engine's `skipReasonCounts` at the type boundary. An integer cannot tell "your plan caps DNS records"
// from "the restore token lacks the edit scope for this surface" from "the snapshot item is malformed",
// and those are three tickets with three different remedies. The customer was left knowing something did
// not land and not knowing whether the fix was a wider token.
//
// WHAT IS RENDERED AND WHAT IS NOT. The CLASS and its COUNT, never a message. The raw Cloudflare sentence
// the engine classified from stays in the operator's live response and is recorded nowhere, which is what
// makes this tally safe on a receipt and safe in a support pack.
//
// DEGRADING THE WAY THE ENGINE DOES, which is the design note that matters most here. The engine
// deliberately made its safety property independent of the classifier: a real refusal worded so that it
// falls through to `other` STILL FAILS the apply, so nothing rests on a pattern matching Cloudflare's
// wording. This module mirrors that. `other` gets a line of its own rather than being dropped, and a class
// this console does not recognise (a newer engine) is still counted and still named as unclassified,
// because a skip the screen silently omits is exactly the silence the whole tally exists to end.
//
// ONE CLASS IS NOT A PROBLEM AND MUST NOT BE WORDED AS ONE. `entitlement` means the account's PLAN does
// not carry the surface or the feature, so there is no item to restore and nothing to fix. The engine's
// own predicate excludes it from the classes that fail an apply (restore-apply.ts unrestoredCfSkips), on
// the ground that reddening a restore which is complete with respect to the account trains an operator to
// stop reading `ok`. Telling that customer to widen a token would send them to fix something that is not
// broken.
//
// THE WORDING IS DELIBERATELY CAUTIOUS ABOUT ONE THING. This path has not been driven against a live
// Cloudflare account with a genuinely narrow token, so the real refusal's exact wording is unseen. Every
// line below is written to be true whether the class comes back as its specific member or as `other`.
//
// House style: Australian English, no em dashes, precise claims.

import type { CfConfigSkipClass } from "../../api.ts";

// CF_SKIP_LINE is one line per class: what happened, then what to do about it. It is total over the closed
// union, so a member added to the engine and mirrored here cannot be left without copy.
const CF_SKIP_LINE: Readonly<Record<CfConfigSkipClass, string>> = {
  auth: "the Cloudflare token you supplied for this restore was rejected or does not carry the edit scope for this surface, so nothing on it applied. Widen the token's scope and run the restore again.",
  entitlement: "your Cloudflare plan does not include this surface, so there was nothing to restore into. Nothing is wrong and there is nothing to fix.",
  quota: "the account is at its plan limit for this resource, so there was no room for the item. Free space or raise the plan, then run the restore again.",
  validation: "Cloudflare refused the item as invalid. Raise it with support quoting the run id, and recover the surface from the verified snapshot out of band.",
  conflict: "a live item already occupies the same key. Remove or rename it in Cloudflare, then run the restore again.",
  "no-live-id": "the item differs from what is live and the live item carries no id to update in place, so there was nothing to write to. Re-create it from the verified snapshot out of band.",
  "no-live-phase": "no live ruleset exists for this phase, and creating one is a reprovisioning step a restore does not take. Provision it in Cloudflare, then run the restore again.",
  "live-only-rules": "the live ruleset holds rules the snapshot does not, and a restore never deletes, so the ruleset was left as it is.",
  "rate-limited": "Cloudflare rate-limited the write. Run the restore again.",
  "api-unavailable": "Cloudflare returned a server-side fault. Run the restore again.",
  other: "Cloudflare refused the item for a reason this console does not recognise. Cloudflare's own message was in the restore response at the time; the run id and this receipt are what support needs.",
};

// UNCLASSIFIED_LINE covers a class a NEWER engine sends that this console's union does not carry. It is the
// same honesty as `other` and it exists for the same reason: a skip the screen drops because it matched
// nothing is worse than a skip the screen cannot fully explain.
const UNCLASSIFIED_LINE = "this engine reported a refusal class this console does not recognise, which happens when the engine is newer than the console. The count is real; update the console to read the reason.";

// cfSkipLine returns the sentence for one class. Total by construction over the closed union, and honest
// for anything outside it.
export function cfSkipLine(cls: string): string {
  return (CF_SKIP_LINE as Record<string, string | undefined>)[cls] ?? UNCLASSIFIED_LINE;
}

// cfSkipIsBenign answers whether a class means nothing is wrong. Only `entitlement` does, and this mirrors
// the engine's own predicate rather than restating it from memory: engine restore-apply.ts unrestoredCfSkips
// excludes exactly this one member and no other.
export function cfSkipIsBenign(cls: string): boolean {
  return cls === "entitlement";
}

// cfSkipEntries turns a skip tally into the ordered [class, count] pairs to render: zero and negative counts
// dropped, the classes that leave the account short of the archive FIRST, and the benign one last so it
// never sits above a refusal that needs an action.
export function cfSkipEntries(counts: Partial<Record<CfConfigSkipClass, number>> | undefined): Array<[string, number]> {
  if (!counts) return [];
  const rows: Array<[string, number]> = [];
  for (const [cls, n] of Object.entries(counts)) {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
    rows.push([cls, n]);
  }
  rows.sort((a, b) => Number(cfSkipIsBenign(a[0])) - Number(cfSkipIsBenign(b[0])));
  return rows;
}

// cfSkipsNeedAction is what the surface's heading reads off: whether ANY of its skips left an item from the
// verified archive out of the account. A surface skipping only on entitlement fully applied with respect to
// the account and must not be flagged.
export function cfSkipsNeedAction(counts: Partial<Record<CfConfigSkipClass, number>> | undefined): boolean {
  return cfSkipEntries(counts).some(([cls]) => !cfSkipIsBenign(cls));
}
