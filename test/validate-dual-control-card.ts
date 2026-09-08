// The dual-control posture card, driven through the REAL dualControlCard.
//
//   node test/validate-dual-control-card.ts
//
// This card is the governance READ for the mechanic that gates a restore writing to live data: a second
// authorised identity, bound to the exact plan hash, with the maker barred from being the checker. The
// inboxes act; this card is where an operator (or an auditor) looks to see whether anything is waiting.
//
// So its degradation branches are the point, and there are four of them, each of which must be
// distinguishable from the others:
//
//   - both queues read      -> the posture grid, with the counts
//   - config queue fails    -> the config tile is OMITTED, and the restore read beside it is untouched.
//                              A build without the change gate 404s here, and that must never degrade
//                              the half that does work.
//   - approvals 404 or 501  -> the pending-engine note. The count is UNKNOWN, and the card says so
//                              rather than rendering a zero, because "no restores are waiting" and "I
//                              could not ask" look identical on screen and mean opposite things.
//   - approvals otherwise   -> a retryable block error. A 500 is a fault to retry, not a missing feature.
//
// The zero-versus-unknown distinction is the one worth the most here. A card that showed 0 pending on a
// failed read would tell an auditor that nothing awaited sign-off, which is the exact false negative
// dual control exists to prevent.

import { installDomShim, qsa, textOf, flushAsync } from "./dom-shim.ts";
installDomShim();

const { dualControlCard } = await import("../src/screens/access-security/roles.ts");
const store = await import("../src/lib/store.ts");
const { markConnected } = await import("./dom-shim.ts");

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// A 404/501-shaped error: classifyError reads the status off the MESSAGE, so a trailing ": 404" is what
// the not-wired branch keys on (a status PROPERTY is ignored).
const serverError = (status: number): Error => new Error(`list approvals: ${status}`);

const approval = (status: string) => ({ planHash: `hash-${status}`, status, requestedBy: "a@b.example" });

// render drives the real card with scripted queue reads and returns the settled text.
async function render(opts: {
  approvals: unknown[] | Error;
  configChanges?: unknown[] | Error;
}): Promise<{ text: string; el: HTMLElement }> {
  // The real Caller shape (see validate-restore-approvals.ts): method, email, role, groups, isOnlyOwner.
  store.setCaller({ method: "access", email: "owner@example.com", role: "owner", groups: [], isOnlyOwner: true } as never);
  store.connect("https://engine.test");
  const engine = store.getEngine() as unknown as Record<string, unknown>;
  engine.listApprovals = () => (opts.approvals instanceof Error ? Promise.reject(opts.approvals) : Promise.resolve(opts.approvals));
  engine.listConfigChanges = () => {
    const c = opts.configChanges;
    if (c === undefined) return Promise.resolve([]);
    return c instanceof Error ? Promise.reject(c) : Promise.resolve(c);
  };
  const el = dualControlCard(engine as never);
  markConnected(el as unknown as never);
  await flushAsync();
  return { text: textOf(el as unknown as never), el };
}

// The card's live region: everything that varies lands here, so assertions read it rather than the
// static explanatory copy around it.
function regionText(el: HTMLElement): string {
  const region = qsa(el, "div").find((d) => String((d as unknown as { className?: string }).className ?? "").includes("async-region"));
  return region === undefined ? "" : textOf(region as unknown as never);
}

// tileValue reads the NUMBER out of one named posture tile.
//
// Reading the region as one string and asking whether it contains "2" is not good enough: with two
// requested restores and two pending config changes, a regression that counted all four approvals as
// pending would still leave a "2" in the region (the config tile's), so the assertion would pass while
// the number an auditor reads was wrong. Each count must be read from its own tile.
function tileValue(el: HTMLElement, title: string): string | null {
  const candidates = qsa(el, "div").filter((d) => textOf(d as unknown as never).includes(title));
  if (candidates.length === 0) return null;
  // The smallest subtree containing the title is the tile itself, not the grid around it.
  let best = candidates[0] as unknown as never;
  for (const c of candidates) if (textOf(c as unknown as never).length < textOf(best).length) best = c as unknown as never;
  const after = textOf(best).split(title)[1] ?? "";
  const m = after.match(/\d+/);
  return m === null ? null : m[0];
}

async function main(): Promise<void> {
  console.log("(1) both queues read: the posture grid carries the counts");
  {
    const { el, text } = await render({
      approvals: [approval("requested"), approval("approved"), approval("requested"), approval("rejected")],
      configChanges: [{ status: "pending" }, { status: "applied" }, { status: "pending" }],
    });
    const r = regionText(el);
    ok("(1a) the region settled to something", r.length > 0);
    // Only "requested" counts as awaiting sign-off: an approved or rejected row is finished business, and
    // counting them would inflate the number an auditor reads.
    ok("(1b) the restore tile shows 2, counting only the REQUESTED approvals", tileValue(el, "Restores awaiting approval") === "2");
    ok("(1c) the config tile shows 2, counting only the PENDING changes", tileValue(el, "Config changes awaiting approval") === "2");
    ok("(1d) the server-enforced maker rule tile is present", r.includes("Maker is not the checker") && r.includes("Enforced"));
    ok("(1e) the maker-is-not-the-checker rule is stated", text.includes("maker barred from being the checker"));
    ok("(1f) and that approving and applying are separate recorded steps", text.includes("Approving and applying are separate"));
  }

  console.log("\n(2) mixed approvals: a queue with nothing REQUESTED reads as zero, not as absent");
  {
    const { el } = await render({ approvals: [approval("approved"), approval("rejected")], configChanges: [] });
    const r = regionText(el);
    ok("(2a) the grid still renders", r.length > 0);
    ok("(2b) the restore tile shows a real zero", tileValue(el, "Restores awaiting approval") === "0");
    ok("(2b2) and reads as clear rather than needing a checker", r.includes("clear") && !r.includes("needs a checker"));
    // The distinction this file exists for: a genuine zero must NOT look like a failed read.
    ok("(2c) and does NOT show the could-not-load note", !r.includes("could not load"));
  }

  console.log("\n(3) the config queue failing OMITS its tile and leaves the restore read intact");
    // A build without the change gate 404s here. That absence must never degrade the half that works.
    for (const status of [404, 501, 500]) {
      const { el } = await render({ approvals: [approval("requested")], configChanges: serverError(status) });
      const r = regionText(el);
      ok(`(3) config ${status}: the restore tile still shows its count`, tileValue(el, "Restores awaiting approval") === "1");
      ok(`(3) config ${status}: the CONFIG tile is omitted entirely`, !r.includes("Config changes awaiting approval"));
      ok(`(3) config ${status}: the card does not fall into an error state`, !r.includes("could not load"));
    }

  console.log("\n(4) approvals 404 or 501: the PENDING-ENGINE note, never a fabricated zero");
    for (const status of [404, 501]) {
      const { el } = await render({ approvals: serverError(status) });
      const r = regionText(el);
      ok(`(4) approvals ${status}: the card says the count could not load`, r.includes("could not load"));
      ok(`(4) approvals ${status}: it names the route it depends on`, r.includes("GET /admin/restore/approvals"));
      ok(`(4) approvals ${status}: it reports what the engine returned`, r.includes(String(status)));
      // The load-bearing negative. An unknown count must not be rendered as zero pending.
      ok(`(4) approvals ${status}: it still states the maker/checker split is design-complete`, r.includes("design-complete"));
    }

  console.log("\n(5) any other approvals failure is a RETRYABLE block error, not a missing feature");
    for (const status of [500, 502, 503]) {
      const { el } = await render({ approvals: serverError(status) });
      const r = regionText(el);
      // A 500 is a fault to retry. Rendering the pending-engine note for it would tell the operator the
      // feature was never built, which is a wrong diagnosis and stops them retrying.
      ok(`(5) approvals ${status}: it does NOT claim the feature is unbuilt`, !r.includes("design-complete"));
      const buttons = qsa(el, "button").map((b) => String((b as unknown as { textContent: string }).textContent ?? ""));
      ok(`(5) approvals ${status}: a retry control is offered`, buttons.some((t) => /retry|try again/i.test(t)));
    }

  console.log("\n(6) the two branches are mutually exclusive, so a reader can always tell them apart");
  {
    const notWired = regionText((await render({ approvals: serverError(404) })).el);
    const fault = regionText((await render({ approvals: serverError(500) })).el);
    ok("(6a) the not-wired note and the block error render different text", notWired !== fault);
    ok("(6b) only the not-wired branch says design-complete", notWired.includes("design-complete") && !fault.includes("design-complete"));
    const ok404 = regionText((await render({ approvals: [approval("requested")] })).el);
    ok("(6c) and the healthy grid differs from both", ok404 !== notWired && ok404 !== fault);
  }

  console.log(`\n${failures === 0 ? "DUAL-CONTROL-CARD OK: a failed read is never rendered as zero pending, a missing config queue never degrades the restore read, and a 500 stays retryable" : `${failures} FAILURE(S)`}`);
  if (failures > 0) (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
}

main().catch((e) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): never } }).process.exit(1);
});
