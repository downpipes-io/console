// The verified-apply provenance block's read-back verdicts, driven through the REAL renderProvenanceBody.
//
//   node test/validate-provenance-readback.ts
//
// SCOPE NOTE. The plan asked for "three read-back verdicts and five cross-check outcomes". The
// cross-check half no longer exists: it was a button that fetched the published release record and
// compared digests in the browser, it was DEAD in the shipped console because connect-src is exactly
// 'self', and it was removed rather than proxied, because channelBase comes from the
// engine's operator-configurable UPDATE_CHANNEL_URL and a Worker route fetching it would buy an SSRF
// surface for a convenience. So this file covers the three verdicts, and adds a guard that the dead
// control cannot come back.
//
// What the block is for: it is the CUSTOMER-side half of the provenance story, read out of this
// account's own hash-chained records rather than from a vendor claim. Its honesty is the whole point,
// which makes the "not available" branch as important as the other two: an apply whose read-back was
// never taken must say so, not fall silent in a way that reads like success.

import { installDomShim, textOf, qsa } from "./dom-shim.ts";
installDomShim();

const { renderProvenanceBody } = await import("../src/screens/licence/provenance.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const DIGEST = "a".repeat(96);
const PLATFORM = `b1c2d3e4f5061728${"9".repeat(80)}`;

// render builds the minimum LicenceData the block reads and returns the rendered text.
function render(last: unknown): { text: string; el: HTMLElement } {
  const data = {
    licence: { tier: "enterprise" },
    updates: {},
    status: { engineVersion: "0.1.9" },
    updateState: last === null ? null : { last },
  };
  const el = renderProvenanceBody(data as never);
  markConnected(el as unknown as never);
  return { text: textOf(el as unknown as never), el };
}

// digest is passed as an EXPLICIT tri-state rather than an optional parameter. A default value is
// applied to an explicit `undefined` too, so `applied(rb, undefined)` originally still produced a full
// digest and the "missing digest" case silently tested the present-digest path instead.
const applied = (readback: unknown, digest: { kind: "full" } | { kind: "omitted" } | { kind: "empty" } = { kind: "full" }) => ({
  outcome: "applied",
  recommendedVersion: "0.1.9",
  ...(digest.kind === "omitted" ? {} : { artefactSha384: digest.kind === "empty" ? "" : DIGEST }),
  ...(readback === undefined ? {} : { readback }),
});

async function main(): Promise<void> {
  console.log("(1) verdict 'verified': the platform returned byte-exact the signed bundle");
  {
    const { text } = render(applied({ verdict: "verified" }));
    ok("(1a) the block is rendered", text.includes("Verified apply (this account)"));
    ok("(1b) the outcome names applied and the version", text.includes("applied 0.1.9"));
    ok("(1c) the read-back row says verified, byte-exact, before promotion", text.includes("verified: Cloudflare's own API returned byte-exact the signed bundle before promotion"));
    ok("(1d) it does NOT hedge with 'not available'", !text.includes("not available for that apply"));
  }

  console.log("\n(2) verdict 'mismatch': stated as a possible incident, with the platform digest truncated");
  {
    const { text } = render(applied({ verdict: "mismatch", deployedSha384: PLATFORM }));
    ok("(2a) the row leads with mismatch", text.includes("mismatch: the platform's bytes differed from the signed digest"));
    ok("(2b) it tells the operator how to treat it", text.includes("treat as an incident if unexplained"));
    // Truncated to 16 characters plus an ellipsis: enough to compare by eye against the signed digest
    // above it, without a second 96-character string competing with it on the same row.
    ok("(2c) the platform digest is shown truncated to 16 characters", text.includes(`(platform ${PLATFORM.slice(0, 16)}`));
    ok("(2d) and NOT in full", !text.includes(`platform ${PLATFORM})`));
    // A mismatch with no platform digest recorded must still be a mismatch, just without the aside.
    const bare = render(applied({ verdict: "mismatch" }));
    ok("(2e) a mismatch with no platform digest still reads as a mismatch", bare.text.includes("mismatch: the platform's bytes differed"));
    ok("(2f) with no empty parenthetical", !bare.text.includes("(platform )"));
  }

  console.log("\n(3) any other verdict is 'not available', recorded honestly rather than assumed");
  {
    // This is the branch that matters most for honesty. An apply whose read-back was never taken must
    // say so; treating an absent verdict as success would be the one failure this block exists to prevent.
    const { text } = render(applied({ verdict: "unavailable", detail: "the platform API returned 500" }));
    ok("(3a) it says the read-back is not available for that apply", text.includes("not available for that apply"));
    ok("(3b) it carries the recorded detail", text.includes("the platform API returned 500"));
    ok("(3c) and says it is recorded honestly rather than assumed", text.includes("recorded honestly rather than assumed"));
    ok("(3d) it never claims verification", !text.includes("verified: Cloudflare's own API"));
    const noDetail = render(applied({ verdict: "skipped" }));
    ok("(3e) an unknown verdict with no detail still refuses to claim verification", noDetail.text.includes("not available for that apply") && !noDetail.text.includes("byte-exact"));
    ok("(3f) with no empty parenthetical", !noDetail.text.includes("()"));
  }

  console.log("\n(4) no read-back recorded at all: the row is omitted, not faked");
  {
    const { text } = render(applied(undefined));
    ok("(4a) the verified-apply block still renders", text.includes("Verified apply (this account)"));
    ok("(4b) there is no Platform read-back row", !text.includes("Platform read-back"));
    ok("(4c) and no verdict wording of any kind", !text.includes("byte-exact") && !text.includes("not available for that apply"));
  }

  console.log("\n(5) the signed digest is shown in full, or its absence is stated");
  {
    const { text, el } = render(applied({ verdict: "verified" }, { kind: "full" }));
    ok("(5a) the signed digest is rendered in full, for comparison by eye", text.includes(DIGEST));
    ok("(5b) in a monospace code element", qsa(el, "code").length >= 1);
    for (const kind of ["omitted", "empty"] as const) {
      const r = render(applied({ verdict: "verified" }, { kind }));
      ok(`(5c) an ${kind} digest states why rather than showing nothing`, r.text.includes("recorded before content-hash evidence"));
      ok(`(5d) an ${kind} digest promises the next apply records one`, r.text.includes("the next apply records its digest automatically"));
    }
  }

  console.log("\n(6) a rolled-back apply is reported as rolled back, not as applied");
  {
    const { text } = render({ outcome: "rolled-back", recommendedVersion: "0.1.8", artefactSha384: DIGEST, readback: { verdict: "verified" } });
    ok("(6a) the outcome reads rolled back", text.includes("rolled back 0.1.8"));
    ok("(6b) and not applied", !text.includes("applied 0.1.8"));
  }

  console.log("\n(7) the block is omitted entirely when there is no settled apply to describe");
    ok("(7a) a null updateState renders no verified-apply block", !render(null).text.includes("Verified apply (this account)"));
    // An unknown or in-flight outcome is not a settled apply, so it must not be dressed as one.
    for (const outcome of ["pending", "unknown", ""]) {
      const { text } = render({ outcome, recommendedVersion: "0.1.9" });
      ok(`(7b) outcome ${JSON.stringify(outcome)} renders no verified-apply block`, !text.includes("Verified apply (this account)"));
    }

  console.log("\n(8) the dead cross-check control must not come back");
  {
    // Regression guard for the removal. The old control was a button that could never
    // succeed under connect-src 'self', and whose only reachable message blamed the channel host for the
    // console's own policy. If a well-meaning change re-adds an in-browser fetch here, this fails.
    const { el, text } = render(applied({ verdict: "verified" }));
    const labels = qsa(el, "button").map((b) => String((b as unknown as { textContent: string }).textContent ?? ""));
    // The one legitimate button here opens the open-source licence list, so this cannot simply ban
    // buttons. It bans a control that offers to CHECK something, which is what the dead one did.
    ok("(8a) the only button is the open-source licences one", labels.length === 1 && labels[0]?.includes("Open-source licences") === true);
    ok("(8b) no control offers to cross-check or verify against the release record", !labels.some((l) => /cross-check|check|verify|compare/i.test(l)));
    ok("(8c) and no copy blames the channel host for a blocked read", !text.includes("may not allow browser reads"));
  }

  console.log(`\n${failures === 0 ? "PROVENANCE-READBACK OK: verified, mismatch and not-available each read honestly, an absent read-back is omitted rather than faked, and the dead cross-check stays gone" : `${failures} FAILURE(S)`}`);
    if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
