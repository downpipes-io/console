// Trust area of the validate-components suite: the accessVerdictFromCaller state
// machine and the verdict<->trust-chip tone mirror contract.

import { accessVerdictFromCaller, _testChipTone } from "../src/components/trust-chips.ts";
import type { AccessVerdict } from "../src/components/trust-chips.ts";
import { _testPresentAccessTone } from "../src/components/verdict.ts";
import { makeCaller } from "./validate-components-shared.ts";

type Ok = (label: string, cond: boolean) => void;

// Section 5 (the accessVerdictFromCaller state machine).
export function runTrustStateMachine(ok: Ok): void {

// ===========================================================================
// 5. TRUST CHIPS -- accessVerdictFromCaller STATE MACHINE
// ===========================================================================
// accessVerdictFromCaller maps (Caller | null, whoamiAvailable) to an AccessVerdict.
// The "verified" state is the only trust/teal state; everything else is warn or
// neutral. The state machine has five states; we check every transition.
//
// Critical invariant: "verified" is ONLY reachable when whoamiAvailable=true
// AND the caller's method is "access". Any other path must not produce "verified".

console.log("\n-- trust-chips accessVerdictFromCaller --");

// 5a. Verified: whoami available + method "access" => verified with email.
{
  const v = accessVerdictFromCaller(makeCaller("access", "tim@example.com"), true);
  ok("verified: state is 'verified'", v.state === "verified");
  // The email must be threaded through.
  ok("verified: email is present", v.state === "verified" && v.email === "tim@example.com");
}

// 5b. Verified with identity provider.
{
  const v = accessVerdictFromCaller(makeCaller("access", "tim@example.com", "Google SSO"), true);
  ok("verified with idP: state is 'verified'", v.state === "verified");
  ok("verified with idP: identityProvider is set", v.state === "verified" && v.identityProvider === "Google SSO");
}

// 5c. Token fallback: whoami available + method "token" => token-fallback (never verified).
{
  const v = accessVerdictFromCaller(makeCaller("token"), true);
  ok("token fallback: state is 'token-fallback'", v.state === "token-fallback");
  // Negative control: a token fallback must NOT be 'verified'.
  ok("token fallback: NOT 'verified'", v.state !== "verified");
}

// 5d. Unknown: whoami NOT available (null caller) => unknown.
{
  const v = accessVerdictFromCaller(null, false);
  ok("unknown: null caller => 'unknown'", v.state === "unknown");
}

// 5e. Unknown: whoami NOT available (non-null caller but whoamiAvailable=false) => unknown.
// The caller being non-null is not enough; whoamiAvailable drives the outer branch.
{
  const v = accessVerdictFromCaller(makeCaller("access", "tim@example.com"), false);
  ok("unknown: whoamiAvailable=false overrides a present caller => 'unknown'", v.state === "unknown");
  // Negative control (F7): the verified path requires BOTH conditions; a caller alone
  // must not produce 'verified' when whoamiAvailable is false.
  ok("verified NOT reachable when whoamiAvailable=false, even with access-method caller", v.state !== "verified");
}

// 5f. Unknown: null caller even when whoamiAvailable=true => unknown.
{
  const v = accessVerdictFromCaller(null, true);
  ok("unknown: null caller with whoamiAvailable=true => 'unknown'", v.state === "unknown");
  ok("null caller cannot produce 'verified'", v.state !== "verified");
}

// 5g. Completeness: the six combinations cover the reachable branches. No branch
// returns a state outside the union (the TypeScript type already enforces this, but
// the runtime check confirms nothing is undefined/null at the value level).
const states: Array<AccessVerdict["state"]> = [
  accessVerdictFromCaller(makeCaller("access", "a@b.com"), true).state,
  accessVerdictFromCaller(makeCaller("token"), true).state,
  accessVerdictFromCaller(null, true).state,
  accessVerdictFromCaller(null, false).state,
  accessVerdictFromCaller(makeCaller("access"), false).state,
];
const knownStates = new Set<string>(["verified", "token-fallback", "session-present", "unverified", "unknown"]);
ok("all produced states are within the AccessVerdict union", states.every((s) => knownStates.has(s)));

// 5h. The trust/teal gating invariant: "verified" is the ONLY state produced from
// the access-method + whoami-available path. Every other path must produce a
// non-verified state.
const verifiedPaths: Array<[Parameters<typeof accessVerdictFromCaller>[0], boolean]> = [
  [makeCaller("access", "a@b.com"), true],
];
const nonVerifiedPaths: Array<[Parameters<typeof accessVerdictFromCaller>[0], boolean]> = [
  [makeCaller("token"), true],
  [null, true],
  [null, false],
  [makeCaller("access"), false],
  [makeCaller("token"), false],
];
ok("verified-path produces 'verified'", verifiedPaths.every(([c, w]) => accessVerdictFromCaller(c, w).state === "verified"));
ok("all non-verified paths produce a non-'verified' state", nonVerifiedPaths.every(([c, w]) => accessVerdictFromCaller(c, w).state !== "verified"));

}

// Section 11 (the verdict<->trust-chip tone mirror contract). Run later, after
// the modal/drawer and access-security label/probe groups, matching the order.
export function runTrustMirror(ok: Ok): void {

// ===========================================================================
// 11. VERDICT <-> TRUST-CHIP TONE MIRROR CONTRACT
// ===========================================================================
// presentAccess() in verdict.ts and present() in trust-chips.ts map the same
// AccessVerdict union to a tone. The two must agree on every state so the
// compact chip and the expanded panel never show contradictory colours.
//
// The test verifies tone equality for all five states of the union using the
// exported test hooks _testPresentAccessTone (verdict.ts) and _testChipTone
// (trust-chips.ts). Both are pure functions; no DOM is involved.
//
// Critical invariant: "trust" is the ONLY tone for "verified"; every non-
// verified state must be "warn" or "neutral" in BOTH surfaces simultaneously.

console.log("\n-- verdict<->trust-chip tone mirror contract --");

// All five AccessVerdict states, one representative each.
const mirrorCases: Array<{ label: string; verdict: AccessVerdict; expectedTone: "trust" | "warn" | "neutral" }> = [
  {
    label: "verified",
    verdict: { state: "verified", email: "tim@example.com" },
    expectedTone: "trust",
  },
  {
    label: "token-fallback",
    verdict: { state: "token-fallback" },
    expectedTone: "warn",
  },
  {
    label: "session-present",
    verdict: { state: "session-present" },
    expectedTone: "warn",
  },
  {
    label: "unverified",
    verdict: { state: "unverified" },
    expectedTone: "warn",
  },
  {
    label: "unknown",
    verdict: { state: "unknown" },
    expectedTone: "neutral",
  },
];

for (const { label, verdict, expectedTone } of mirrorCases) {
  const chipTone = _testChipTone(verdict);
  const panelTone = _testPresentAccessTone(verdict);
  // The chip and the panel must agree with each other.
  ok(`chip and panel agree on tone for '${label}'`, chipTone === panelTone);
  // Both must match the expected tone from the design contract.
  ok(`chip tone for '${label}' matches expected '${expectedTone}'`, chipTone === expectedTone);
  ok(`panel tone for '${label}' matches expected '${expectedTone}'`, panelTone === expectedTone);
}

// Critical invariant via the mirror: only "verified" produces "trust" tone.
// Every other state must not produce "trust" in either surface.
const nonVerifiedVerdicts: AccessVerdict[] = [
  { state: "token-fallback" },
  { state: "session-present" },
  { state: "unverified" },
  { state: "unknown" },
];
ok(
  "only 'verified' produces trust tone in the chip",
  nonVerifiedVerdicts.every((v) => _testChipTone(v) !== "trust"),
);
ok(
  "only 'verified' produces trust tone in the panel",
  nonVerifiedVerdicts.every((v) => _testPresentAccessTone(v) !== "trust"),
);
// Negative control: if the trust tone were incorrectly applied to 'unknown', these
// would fail. Confirm 'unknown' is explicitly 'neutral' in both surfaces.
ok(
  "negative: 'unknown' is neutral in chip, not trust or warn",
  _testChipTone({ state: "unknown" }) === "neutral",
);
ok(
  "negative: 'unknown' is neutral in panel, not trust or warn",
  _testPresentAccessTone({ state: "unknown" }) === "neutral",
);

}
