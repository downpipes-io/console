// TC-dest-offaccount-lock-finding: the Destinations screen's own posture note, added alongside the owner
// decision that an in-account R2 destination no longer wears the trust/preferred badge (destination-cards.ts
// PROVIDER_BADGE, sources-downpipes/helpers.ts r2DestBlock/outOfAccountDestBlock). R2 offers no Object Lock,
// versioning, legal hold or MFA-delete, and an in-account bucket shares this account's own credential and
// blast radius with the sources it protects, so an all-in-account destination set is the one configuration
// that deserves a calm, honest note rather than silence.
//
// This is a FINDING, not a failure: an estate with only R2 is still working and still backed up, so nothing
// here turns their green state red. It is a warning-tone, non-dismissible banner (offAccountLockFinding in
// destination-cards.ts), shown above the destination table (renderList) and above the single deploy-time
// posture card (renderConfigured) whenever no destination is both off-account (not R2) AND Object-Lock
// enforced on the live probe. Run with: node test/validate-dest-offaccount-lock-finding.ts

import { installDomShim, qsa, textOf, type ShimNode } from "./dom-shim.ts";

installDomShim();

import { SN } from "./validate-stable-components-shared.ts";
import { renderConfigured, renderList } from "../src/screens/destination-cards.ts";
import { destinationClarity } from "../src/screens/sources-downpipes/helpers.ts";
import type { DestinationList, DestinationStatus, EngineClient } from "../src/api.ts";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean, measured?: string): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && measured ? `\n         measured: ${measured}` : ""}`);
  if (!cond) failures++;
}

const STUB_ENGINE = { listHistory: async () => [] } as unknown as EngineClient;

const FINDING_TEXT = "No destination is outside this account with immutability. A compromise of this account can reach every copy. Add an off-account destination with Object Lock as the primary leg.";

function stFor(over: Partial<DestinationStatus>): DestinationStatus {
  return { present: true, id: "d1", label: "Primary", bucket: "archive", source: "console", ...over };
}

function listOf(...destinations: DestinationStatus[]): DestinationList {
  return { destinations, defaultId: destinations[0]?.id ?? null };
}

function listText(list: DestinationList): string {
  return textOf(SN(renderList(STUB_ENGINE, list, () => undefined)) as unknown as ShimNode);
}

function listBanners(list: DestinationList): string[] {
  const el = renderList(STUB_ENGINE, list, () => undefined);
  return qsa(SN(el) as unknown as ShimNode, ".banner--warn").map((b) => textOf(b));
}

function configuredText(st: DestinationStatus): string {
  return textOf(SN(renderConfigured(STUB_ENGINE, st, () => undefined, 1)) as unknown as ShimNode);
}

function main(): void {
  console.log("-- offAccountLockFinding: presence over destination lists lacking an off-account, Object-Lock leg --");

  // PRESENCE. A single R2 destination: no leg is off-account, so the finding renders, in full and exact.
  {
    const t = listText(listOf(stFor({ endpointHost: "abc123.r2.cloudflarestorage.com" })));
    ok("R2-only: the finding banner is present", t.includes(FINDING_TEXT), t);
    const banners = listBanners(listOf(stFor({ endpointHost: "abc123.r2.cloudflarestorage.com" })));
    ok("R2-only: it is the warn-tone banner (exactly one)", banners.length === 1 && banners[0] === FINDING_TEXT, JSON.stringify(banners));
  }

  // PRESENCE. An off-account S3 leg exists but its Object-Lock is NOT enforced (refused writes): the
  // destination protects nothing, so the finding still applies. Same for "unknown" (never proven).
  {
    const notEnforced = listOf(
      stFor({ id: "d1", endpointHost: "abc123.r2.cloudflarestorage.com" }),
      stFor({ id: "d2", endpointHost: "s3.us-east-1.amazonaws.com", objectLock: "not-enforced", worm: { mode: "compliance", retentionDays: 30 } }),
    );
    ok("R2 + S3 configured-but-refused lock: the finding is still present", listText(notEnforced).includes(FINDING_TEXT));

    const unknown = listOf(stFor({ id: "d1", endpointHost: "s3.us-east-1.amazonaws.com", objectLock: "unknown" }));
    ok("an off-account leg with an UNKNOWN lock read: the finding is still present (unknown is not proof)", listText(unknown).includes(FINDING_TEXT));
  }

  console.log("\n-- offAccountLockFinding: absence once a genuinely off-account, lock-enforced leg exists --");

  // ABSENCE. One destination, off-account (S3) with Object-Lock enforced: the finding does not render.
  {
    const t = listText(listOf(stFor({ endpointHost: "s3.us-east-1.amazonaws.com", objectLock: "enforced", worm: { mode: "compliance", retentionDays: 30 } })));
    ok("a single S3 leg with Object-Lock enforced: the finding is absent", !t.includes(FINDING_TEXT), t);
  }

  // ABSENCE. Two destinations: R2 (no lock, expected) plus an Azure leg that DOES enforce it. R2 stays a
  // valid secondary and draws no finding of its own; the whole set clears because one leg satisfies it.
  {
    const t = listText(
      listOf(
        stFor({ id: "d1", endpointHost: "abc123.r2.cloudflarestorage.com" }),
        stFor({ id: "d2", endpointHost: "myaccount.blob.core.windows.net", objectLock: "enforced", worm: { mode: "compliance", retentionDays: 30 } }),
      ),
    );
    ok("R2 secondary + Azure primary with Object-Lock enforced: the finding is absent", !t.includes(FINDING_TEXT), t);
  }

  // ABSENCE. Google Cloud Storage counts as off-account too (the finding is provider-neutral, not an
  // S3-only rule): the interop API's per-object retention reads as objectLock "enforced" the same way.
  {
    const t = listText(listOf(stFor({ endpointHost: "storage.googleapis.com", objectLock: "enforced", worm: { mode: "compliance", retentionDays: 30 } })));
    ok("a GCS leg with Object-Lock enforced: the finding is absent", !t.includes(FINDING_TEXT), t);
  }

  // EDGE. An empty list (nothing configured yet) draws no finding here: the unconfigured/setup states carry
  // their own copy, and warning about a destination gap while the setup form is the whole screen would be
  // redundant noise, not a second surface for the same fact.
  {
    const t = listText(listOf());
    ok("an empty destination list: no finding (renderSetup covers the unconfigured state)", !t.includes(FINDING_TEXT), t);
  }

  console.log("\n-- offAccountLockFinding on the single deploy-time posture card (renderConfigured) --");

  // The single-destination path (no console record; the deploy-time env binding) carries the same finding,
  // gated on the same rule, over the ONE status renderConfigured is handed.
  {
    const rDeployR2 = configuredText({ present: false, envConfigured: true, envKind: "r2", source: "deploy" } as DestinationStatus);
    ok("deploy-time R2 (no console record): the finding is present", rDeployR2.includes(FINDING_TEXT), rDeployR2);

    const rConsoleS3Locked = configuredText(stFor({ endpointHost: "s3.us-east-1.amazonaws.com", objectLock: "enforced", worm: { mode: "compliance", retentionDays: 30 } }));
    ok("a console-set S3 destination with Object-Lock enforced: the finding is absent", !rConsoleS3Locked.includes(FINDING_TEXT), rConsoleS3Locked);
  }

  console.log("\n-- An enforced lock with no policy: the bucket's own default rule decides --");

  // Object-Lock enabled retains nothing by itself (engine router-posture.ts probeWormCapability). With no
  // worm policy, only the bucket's default retention rule applies a window, and the engine now stores the
  // probe's read of it as defaultRetention. A card that read all three rows below as "ok" would clear the
  // finding, and these checks fail on such code for the "nothing retained" and "not checked" rows.
  {
    const s3 = "s3.us-east-1.amazonaws.com";
    const noRule = stFor({ endpointHost: s3, objectLock: "enforced", defaultRetention: false });
    const rule = stFor({ endpointHost: s3, objectLock: "enforced", defaultRetention: true });
    const unread = stFor({ endpointHost: s3, objectLock: "enforced" });

    const tNoRule = listText(listOf(noRule));
    ok("lock on, no rule, no policy: the finding is present (nothing is retained)", tNoRule.includes(FINDING_TEXT), tNoRule);
    ok("...and the table cell says nothing is retained", tNoRule.includes("Object-Lock on, nothing retained"), tNoRule);
    const cNoRule = configuredText(noRule);
    ok("...and the card carries the warn badge and the note with both remedies", cNoRule.includes("Object-Lock on, nothing retained") && cNoRule.includes("nothing locks the archives") && cNoRule.includes("Set a mode here") && cNoRule.includes("default retention rule"), cNoRule);

    const tRule = listText(listOf(rule));
    ok("lock on with a bucket default rule: the finding is absent", !tRule.includes(FINDING_TEXT), tRule);
    ok("...and the table cell names the bucket default rule", tRule.includes("Object-Lock, bucket default rule"), tRule);
    ok("...and the card carries no retention note", !configuredText(rule).includes("nothing locks the archives"));

    const tUnread = listText(listOf(unread));
    ok("lock on, rule not recorded: the finding is present (an unread rule is not proof)", tUnread.includes(FINDING_TEXT), tUnread);
    ok("...and the table cell says the rule was not checked", tUnread.includes("Object-Lock, rule not checked"), tUnread);
    const cUnread = configuredText(unread);
    ok("...and the card says how to get the read (Replace); console 0.2.8 ships with an engine 0.3.7 floor, so it names no version", cUnread.includes("Save again with Replace") && !cUnread.includes("On engine 0.3.7 or later"), cUnread);

    // AZURE: the engine cannot read a container's default retention policy with a key or a SAS, so it stores
    // no read. The row must not say "no rule" or send the operator to Replace, which cannot record one. A
    // defaultRetention:false on an Azure row (the engine never sends it) must not turn into "nothing retained".
    const azure = "myaccount.blob.core.windows.net";
    for (const [label, row] of [
      ["no read", stFor({ endpointHost: azure, objectLock: "enforced" })],
      ["a stray false", stFor({ endpointHost: azure, objectLock: "enforced", defaultRetention: false })],
    ] as const) {
      const tAz = listText(listOf(row));
      ok(`Azure, lock on, no mode, ${label}: the cell says the rule is not readable, not nothing retained`, tAz.includes("Object-Lock, rule not readable") && !tAz.includes("nothing retained") && !tAz.includes("rule not checked"), tAz);
      ok(`...and the finding stays (an unreadable rule is not proof), ${label}`, tAz.includes(FINDING_TEXT), tAz);
      const cAz = configuredText(row);
      ok(`...and the card names the unreadable policy and the mode remedy, without Replace or "no rule", ${label}`, cAz.includes("cannot read the container's default retention policy") && cAz.includes("set an immutability mode here") && !cAz.includes("with Replace") && !cAz.includes("has no default retention rule") && !cAz.includes("nothing retained"), cAz);
    }

    // CONTROL: a worm policy on an enforced bucket retains whatever the rule read is.
    const tWorm = listText(listOf(stFor({ endpointHost: s3, objectLock: "enforced", defaultRetention: false, worm: { mode: "compliance", retentionDays: 30 } })));
    ok("CONTROL: lock on, no rule, but a policy set: the finding is absent and the cell names the mode", !tWorm.includes(FINDING_TEXT) && tWorm.includes("Object-Lock, compliance"), tWorm);
  }

  console.log("\n-- Regression: R2 no longer wears the trust badge or the Preferred label --");

  // The tone flip this finding travels with: PROVIDER_BADGE's R2 entry moved from trust to default, so
  // the destinations table badge carries no badge--trust class, and the create/import wizard's R2 block
  // (r2DestBlock, via destinationClarity) no longer reads "Preferred". Both are read from the REAL render,
  // not asserted from the source text, so a reversion in either file fails this the same way a copy bug
  // would.
  {
    const list = listOf(stFor({ endpointHost: "abc123.r2.cloudflarestorage.com" }));
    const el = renderList(STUB_ENGINE, list, () => undefined);
    const r2Badge = qsa(SN(el) as unknown as ShimNode, ".badge").find((b) => textOf(b).trim() === "R2");
    ok("the R2 provider badge exists", r2Badge !== undefined);
    ok("...and carries no badge--trust class", !(r2Badge?.className ?? "").includes("badge--trust"), r2Badge?.className);

    const clarity = (destinationClarity({ destKind: "r2", destConfigured: true } as never) as unknown as { textContent: string | null }).textContent ?? "";
    ok("the create/import R2 block no longer says Preferred", !clarity.includes("Preferred"), clarity);
    ok("...and states the no-immutability fact plainly", clarity.includes("no immutability"), clarity);

    const outOfAccount = (destinationClarity({ destKind: "s3", destConfigured: true } as never) as unknown as { textContent: string | null }).textContent ?? "";
    ok("the out-of-account block no longer carries the alarm framing", !outOfAccount.includes("Confirm this is intended"), outOfAccount);
  }

  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
  verdictReached(failures); // the verdict is now DECLARED, so a silent exit 0 cannot pass as green
  if (failures > 0) process.exit(1);
}

main();
