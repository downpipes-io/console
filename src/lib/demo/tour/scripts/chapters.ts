// The guided page-walkthrough scripts: TWO curated walks through the REAL console on the seeded Northwind world
// The welcome card offers a one-tap fork, and
// each choice runs a DIFFERENT walk over the same director:
//   - CTO: assurance, governance and ecosystem fit (no-custody, dual control, change management, signed
//     evidence, the tamper-evident audit log, plus the identity-provider and integration breadth).
//   - Engineer: operate and recover, and wire into your tooling (the estate, a backup end to end, proving
//     recoverability, the honest failure, the canary, plus notifications and integration breadth).
// Both open on Overview/no-custody and close on the funnel; the middle is curated to the reader. A visitor can
// still explore freely and relaunch to take the other path, so nothing is locked away.
//
// A chapter is DATA, not code: a typed array whose route is the typed vocabulary below (a renamed route is a
// `tsc` error here, not a runtime navigation to nowhere), a short nav-bar title, an optional preAction that
// opens a drawer / disclosure / deep-link so the "?"s have something to pin to, and the info-points to pin.
// Each info-point body makes a precise claim the faked engine genuinely demonstrates on the page it annotates,
// and never overclaims a capability the product lacks: "tamper-evident", not "tamper-proof"; "post-quantum
// hybrid", not "quantum-proof". The director (tour/director.ts) is script-agnostic; the chapters are the data
// it runs, and the info-point layer retries a not-yet-present anchor each tick, so a "?" on a drawer the
// preAction opens a beat later still appears the moment that drawer mounts.
//
// House rules: Australian English, precise claims.

import type { TourChapter, TourCta } from "../director.ts";
import { navigate } from "../../../nav.ts";
import { ROUTE_OVERVIEW } from "../../../../screens/overview.ts";
import { ROUTE_SOURCES } from "../../../../screens/sources.ts";
import { ROUTE_DOWNPIPES } from "../../../../screens/sources-downpipes.ts";
import { ROUTE_RUNS } from "../../../../screens/runs.ts";
import { ROUTE_RESTORE, ROUTE_RESTORE_APPROVALS } from "../../../../screens/restore-flow.ts";
import { ROUTE_CANARY } from "../../../../screens/canary.ts";
import { ROUTE_REPORTS } from "../../../../screens/reports.ts";
import { ROUTE_AUDIT } from "../../../../screens/access-security/shared.ts";
import { ROUTE_IDP } from "../../../../screens/idp-connections/shared.ts";
import { ROUTE_RULES } from "../../../../screens/notifications/shared.ts";
import { ROUTE_INTEGRATIONS } from "../../../../screens/integrations.ts";
import { ROUTE_DESTINATIONS } from "../../../../screens/destinations.ts";
import { ROUTE_ONBOARDING_CONNECT } from "../../../../screens/onboarding-ceremony.ts";

// TourRoute is the closed set of SPA routes a chapter may navigate to: the proof-of-moat pages the guided walks
// visit. Typing each chapter's route against this union means a renamed or mistyped route is a `tsc` error in
// the script, not a runtime navigation to nowhere. The literals are the SAME strings the console router serves;
// ROUTE_CHECK below pins them to the live app constants so this union cannot silently drift.
export type TourRoute =
  | "/" // Overview (ROUTE_OVERVIEW)
  | "/sources" // Sources (ROUTE_SOURCES)
  | "/downpipes" // Downpipes (ROUTE_DOWNPIPES)
  | "/runs" // Runs + the run-detail drawer (ROUTE_RUNS)
  | "/restore" // Verify restorability + Restore (ROUTE_RESTORE)
  | "/restore/approvals" // Dual-control restore approvals inbox (ROUTE_RESTORE_APPROVALS)
  | "/canary" // Canary backup flights (ROUTE_CANARY)
  | "/reports" // Reports + evidence packs (ROUTE_REPORTS)
  | "/access/audit" // Security centre audit log (ROUTE_AUDIT)
  | "/access/idp" // Identity providers grid (ROUTE_IDP)
  | "/notifications/rules" // Notification routing rules (ROUTE_RULES)
  | "/integrations" // SIEM / observability / ITSM integrations grid (ROUTE_INTEGRATIONS)
  | "/destinations" // Archive destinations (ROUTE_DESTINATIONS; the training walk's destination chapter)
  | "/onboarding/connect"; // The guided first-run deck's step-1 home (ROUTE_ONBOARDING_CONNECT; training)

// The persona a visitor picks at the welcome card. Each maps to one curated script (TOUR_SCRIPTS). "cto" leads
// with assurance and ecosystem fit; "engineer" leads with operate-and-recover. It is the value the
// persona_chosen analytics event carries (a coarse label, no personal data).
export type TourPersona = "cto" | "engineer";

// A TourChapter narrowed so its route is the typed vocabulary above. The chapter list is an array of
// TypedTourChapter; assignment to ReadonlyArray<TourChapter> (what the director consumes) widens transparently,
// so the director stays script-agnostic while the script carries the compile-time route guarantee.
export interface TypedTourChapter extends TourChapter {
  route: TourRoute;
}

// ROUTE_CHECK pins each TourRoute literal to the route constant its OWNING SCREEN exports, so the union
// cannot drift from the app: if a screen renames an exported route constant this stops compiling. Each
// entry is `satisfies TourRoute`, so a typo on either side fails `tsc`. There is no central ROUTES map to
// pin against any more (it was removed: the router never bound from it, so it silently fell behind the
// screens); every entry here pins to the owning screen's own constant instead, the same pattern the
// breadth routes (idp / notifyRules / integrations) already used. "/reports" previously had no pin at
// all -- an unpinned literal in the same union as the pinned ones -- and is fixed here too.
const ROUTE_CHECK = {
  overview: ROUTE_OVERVIEW satisfies TourRoute,
  sources: ROUTE_SOURCES satisfies TourRoute,
  downpipes: ROUTE_DOWNPIPES satisfies TourRoute,
  runs: ROUTE_RUNS satisfies TourRoute,
  restore: ROUTE_RESTORE satisfies TourRoute,
  restoreApprovals: ROUTE_RESTORE_APPROVALS satisfies TourRoute,
  canary: ROUTE_CANARY satisfies TourRoute,
  reports: ROUTE_REPORTS satisfies TourRoute,
  audit: ROUTE_AUDIT satisfies TourRoute,
  idp: ROUTE_IDP satisfies TourRoute,
  notifyRules: ROUTE_RULES satisfies TourRoute,
  integrations: ROUTE_INTEGRATIONS satisfies TourRoute,
  destinations: ROUTE_DESTINATIONS satisfies TourRoute,
  onboardingConnect: ROUTE_ONBOARDING_CONNECT satisfies TourRoute,
} as const;

// TOUR_ROUTES is the frozen, exported witness that the pinned literals equal the live constants. It carries no
// runtime behaviour beyond proving the routes resolved, and lets a test assert the pins without re-deriving them.
export const TOUR_ROUTES: Readonly<Record<keyof typeof ROUTE_CHECK, TourRoute>> = Object.freeze({ ...ROUTE_CHECK });

// The deep-link run-detail routes the run chapters open in their preAction (the runs screen auto-opens the
// drawer when the route names a {downpipe}/{index}). dp-ledger run 9 is a clean COMPLETED run (the backup
// end-to-end story); dp-payments run 40 is the seeded FAILED run (the "when it goes wrong" story). These are
// fixtures of the seeded Northwind world (demo-seed.ts), not app routes, so they are not in TourRoute.
const RUN_COMPLETED = "/runs/dp-ledger/9";
const RUN_FAILED = "/runs/dp-payments/40";
// The prefilled restore run the proof chapter opens (the blind-restore proof card renders only for a chosen
// run). run-ledger-0009 is the same clean completed run.
const RESTORE_PREFILL = "/restore/run-ledger-0009";

// openRestoreProof deep-links the restore screen to the prefilled clean run, then opens the collapsed "Prove
// this run restores" disclosure the proof card sits inside (the openRecentFlights pattern): a closed <details>
// gives the chapter's "?" anchors no rect, so the subject the chapter narrates would stay hidden. The proof
// card mounts a beat after the deep-link renders (an async history read), so this retries briefly; best-effort
// and DOM-only, and a no-op where the card (or its disclosure) is absent. The director awaits it as the
// chapter's preAction, before the info-points mount.
//
// IT ALSO RE-EXPANDS THE PICK FORM, AND THAT HALF IS NOT TIDINESS. This chapter's last beat is the
// walk's TRY-IT beat: the rail reads "Try it: click Build the restore plan" and the spotlight pulses
// an invitation on the real control. But the deep-link above is a PREFILLED run, so the flow builds
// its plan straight away and collapses the pick form to display:none (restore-flow/flow.ts's
// collapsePickForm), and the button carrying data-tour-id="restore-build" lives inside that form. It
// stays in the DOM, so it resolves, and it measures 0x0 with a null offsetParent, so the spotlight
// paints at opacity 0 and there is nothing on the screen to click. Driven in a real browser at 390,
// 768, 1280 and 1680, the invitation was impossible to follow at every one of them, and the tour said
// so itself: the director's own retry ladder exhausted and emitted
// {"name":"tour_degraded","detail":"anchor-not-visible","route":"/restore","anchor":"restore-build"}
// to the funnel dataset on every visit that dwelt on the beat.
//
// The re-expand goes through the screen's OWN "Change" control rather than reaching into the form's
// style, because that is the affordance a visitor would use and it re-arms the flow properly; the
// tour never fabricates a state the product cannot reach on its own. It is guarded on the anchor
// still being boxless, so a future flow that leaves the form open is untouched, and it leaves the
// three earlier beats of this chapter (restore-no-data, restore-verify, restore-drill) laying out
// exactly as before, at every supported width.
async function openRestoreProof(): Promise<void> {
  navigate(RESTORE_PREFILL);
  for (let attempt = 0; attempt < 20; attempt++) {
    const proof = document.querySelector('[data-tour-id="restore-verify"]');
    if (proof) {
      const details = proof.closest("details") as HTMLDetailsElement | null;
      if (details) details.open = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await revealRestoreBuild();
}

// revealRestoreBuild makes the try-it beat's control reachable, or leaves the screen alone. offsetParent
// is the check that matters and the element's own computed display is not: a descendant of a
// display:none subtree still reports its own display, which is why the collapsed button read as
// visible to everything that had looked at it before.
async function revealRestoreBuild(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const build = document.querySelector('[data-tour-id="restore-build"]') as HTMLElement | null;
    if (build !== null && build.offsetParent !== null) return;
    const change = document.querySelector('[data-dp="restore-flow.button.change"]') as HTMLElement | null;
    if (change !== null && change.offsetParent !== null && typeof change.click === "function") change.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// DEPLOY_STEPS is the deploy page the funnel's PRIMARY exit links to: the website's actual deploy-into-your-
// own-Cloudflare steps, prerequisites included. Deliberately NOT the docs quickstart, which begins AFTER the
// deploy (its first-backup ladder assumes a running console). The live custom domain, never *.workers.dev.
const DEPLOY_STEPS = "https://downpipes.io/deploy";

// PRICING_URL is the one commercial page every conversion path channels to (owner direction):
// the pricing page carries the enterprise-support offer, so "see pricing" is the honest ask everywhere. The
// `src` query names the path taken (early exit / finale / free-roam) and is counted server-side on
// downpipes.io, so the tour itself still sends nothing anywhere.
export const PRICING_URL = "https://downpipes.io/pricing";

// FUNNEL_CTAS are the two deliberate exits the closing funnel chapter presents (DESIGN): the primary
// self-deploy (the website's deploy steps) and the secondary pricing page (enterprise support is the only
// thing for sale, and the page says so). The `kind` is the coarse, fixed descriptor the cta_clicked analytics
// event carries. Copy framing (must stay true, matching the website): the software is free with nothing to
// unlock, AND it runs in the visitor's own Cloudflare account, which carries Cloudflare's own cost (a Workers
// Paid plan at US$5 a month, plus usage); the paid product is enterprise SUPPORT and the accountable
// signature. Emphasis mirrors the business honestly: the self-deploy stays primary after a free-software
// close; the label promises a PAGE, not a conversation.
export const FUNNEL_CTAS: ReadonlyArray<TourCta> = [
  { label: "Deploy it in your own Cloudflare", href: DEPLOY_STEPS, kind: "deploy-final", primary: true },
  { label: "See enterprise support pricing", href: `${PRICING_URL}?src=pricing-final`, kind: "pricing-final" },
];

// FUNNEL_CTA_LEAD is the one honest line above the pair (the finale's framing in visitor terms): the software
// is free, the Cloudflare account it runs in is not (the website's pricing page draws the same line: a Workers
// Paid plan is required and Cloudflare bills for it directly), and support is the only paid thing.
export const FUNNEL_CTA_LEAD =
  "Everything you just saw is free software. It runs in your own Cloudflare account, which needs a Workers Paid plan: US$5 a month plus usage, paid to Cloudflare, never to us. Support is the only thing for sale.";

// TOUR_EARLY_EXIT is the mid-tour standing exit's data (the rail's "I've seen enough" at the chapter
// index's foot): live from chapter 3 (0-based fromChapter 2, after the first two shared beats) until the
// finale, where the CTA pair takes over. Both scripts share the Overview + Sources opening, so fromChapter 2
// is the first curated chapter in either path. The launcher threads it to the director as config, so the
// director stays script-agnostic.
export const TOUR_EARLY_EXIT = { href: `${PRICING_URL}?src=pricing-early`, kind: "pricing-early", fromChapter: 2 } as const;

// ============================================================================================================
// The chapters, as named building blocks. Each lands on a whole, visible console page and pins "?" info-points
// to its components; a chapter that needs a drawer / disclosure / deep-link opens it in its preAction. The two
// curated scripts (CTO / Engineer) below compose these; a chapter shared by both is defined once.
// ============================================================================================================

// Overview. The post-onboarding landing (SHARED opening): the whole dashboard is visible, and four "?"s explain
// the pieces a technical evaluator cares about: the no-custody guarantee (true by construction), the honest
// fleet health read, the fail-open licence (never a gate), and the "needs your attention" triage.
const overviewChapter: TypedTourChapter = {
  route: "/",
  title: "Overview",
  infoPoints: [
    {
      anchor: "overview-no-custody",
      title: "No custody, by construction",
      body:
        "This chip is a constant the code earns, not a claim. The break-glass private key is generated in your browser and never leaves it; there is no upload path anywhere, so the vendor holds no key and no data. Everything you see here is sample data that resets on reload.",
      placement: "bottom",
    },
    {
      anchor: "overview-fleet-health",
      title: "The honest fleet read",
      body:
        "One plain-English line over every downpipe: how many are covered, backed up but not yet proven, or not covered. It is computed from the same per-downpipe protection statements the rest of the console uses, so it can never disagree with them, and it never reads all-covered unless every enabled pipe's restorability is actually proven.",
      placement: "bottom",
    },
    {
      anchor: "overview-licence",
      title: "Fail-open licence, never a gate",
      body:
        "The licence tier is shown for the record, but it gates nothing: backups and recovery run whether it is valid, expired or absent. A lapsed licence is neutral here, not a warning, because a warning would falsely imply a data-path problem. You buy support and an accountable signature, never a feature unlock.",
      placement: "left",
    },
    {
      anchor: "overview-attention",
      title: "What needs you, and nothing else",
      body:
        "The triage list surfaces only what is actionable right now: an available update to review, recoverability worth proving, Access not yet enforced, a restore awaiting a second sign-off. A failed or stale backup is owned by the loud banner above and the worst-first table, so it is named once, not five times.",
      placement: "left",
    },
  ],
};

// Sources. The catalogue of everything the engine can see and how much of it is protected (SHARED). Three "?"s
// explain the breadth (all eight selectable source types), the protected tier, and the full account catalogue
// behind the disclosure (including Account Config). Eight is the SELECTABLE count (the engine's config
// allow-list; docs/scripts/gen-source-types.mjs records the decision): the format vocabulary holds a ninth,
// artifacts, gated behind Cloudflare's closed beta, which a customer cannot select today.
const sourcesChapter: TypedTourChapter = {
  route: "/sources",
  title: "Sources",
  infoPoints: [
    {
      anchor: "sources-add",
      title: "Eight source types, one tick away",
      body:
        "Add any of the eight Cloudflare source types here: Workers KV, R2 and D1, Secrets Store, Workers, Stream, Images, and 313 zone and account configuration surfaces as Account Config. Connect the account once; after that, choosing what to back up is ticking boxes, not hand-typing bindings.",
      placement: "bottom",
    },
    {
      anchor: "sources-protected",
      title: "Protected, and proven so",
      body:
        "These are the sources attached to the engine AND covered by a downpipe: the orderly, sortable table of what is actually protected, not a ragged list. Activate a row to manage it in Downpipes. The deliberate gaps elsewhere on this page are the point: a console that only ever showed green would be theatre.",
      placement: "top",
    },
    {
      anchor: "sources-catalogue",
      title: "Everything in your account",
      body:
        "Behind this disclosure is the full multi-account catalogue, listed live through your own read-only API token (stored in your account, verified, audited, never re-shown). It is how you see what exists but is not yet protected, the honest coverage gap, including the Account Config surfaces a single token can enumerate.",
      placement: "top",
    },
  ],
};

// Downpipes. The backup configs across the estate, one row per downpipe (ENGINEER). Three "?"s on the top
// row's tight cells: the source type, the schedule, and the honest coverage status.
const downpipesChapter: TypedTourChapter = {
  route: "/downpipes",
  title: "Downpipes",
  infoPoints: [
    {
      anchor: "dp-source-type",
      title: "One downpipe per source",
      body:
        "Each downpipe backs up one Cloudflare source: this pill names its type (KV, R2, D1, Secrets, Config, Workers, Stream, Images or Artifacts). The seeded estate runs every one of the eight selectable types, plus an artifact-registry pipe from Cloudflare's closed beta, so you are looking at a full account, not a toy. Activate a row to manage it.",
      placement: "bottom",
    },
    {
      anchor: "dp-schedule",
      title: "On a schedule you set",
      body:
        "Every downpipe runs on its own cadence: this column reads how often it backs up. Interval schedules are jittered so a large estate spreads its load on the source API rather than stampeding it; a downpipe that misses its cadence reads stale, loudly, rather than quietly going dark.",
      placement: "bottom",
    },
    {
      anchor: "dp-coverage",
      title: "Backed up is not the same as recoverable",
      body:
        "Coverage is the honest per-downpipe read: covered means restorability is actually proven by a restore test, not merely that bytes were written. A backed-up-but-unproven downpipe reads as a gap here, the same logic the Overview fleet line uses, so the two can never disagree.",
      placement: "bottom",
    },
  ],
};

// A backup end to end (ENGINEER). The preAction deep-links the runs screen to a clean COMPLETED ledger run,
// which auto-opens its detail drawer; four "?"s on the drawer's tight values explain what a sealed run is.
const backupChapter: TypedTourChapter = {
  route: "/runs",
  title: "A backup, end to end",
  preAction: () => { navigate(RUN_COMPLETED); },
  infoPoints: [
    {
      anchor: "run-status",
      title: "A run that sealed cleanly",
      body:
        "This run completed and the engine sealed the archive: encrypted, signed and written to the destination. The status here is the run's recorded result, not a hopeful guess. Open any run and you see the same honest detail, including the ones that fail.",
      placement: "right",
    },
    {
      anchor: "run-seal",
      title: "Verified at seal",
      body:
        "Before the engine reports a run a clean success, it reads the just-written archive back and verifies it: the signature, the completeness, and on sampled records a full decrypt-and-hash. The signature is an Ed25519 plus ML-DSA post-quantum hybrid over the run's canonical manifest, verifiable offline with no key shipped to this browser.",
      placement: "right",
    },
    {
      anchor: "run-records",
      title: "Every record accounted for",
      body:
        "The record count is what the engine actually captured this run, read off the wire shape (counts and sizes only; no record contents, no-custody). A run that captured only part of the source says so loudly, so you never rely on a short archive for a full restore.",
      placement: "left",
    },
    {
      anchor: "run-segments",
      title: "Sealed in segments, replicated across destinations",
      body:
        "The archive is written as sealed segments, then fanned out to every destination you configure; this estate has a primary and a replica in a second region, both S3 with Object-Lock in compliance mode. Where Object-Lock is on, the console verifies it by reading the bucket's Object-Lock configuration, the authoritative check, so a sealed segment cannot be deleted or overwritten before its retention expires, not even by the account root.",
      placement: "left",
    },
  ],
};

// Proof it is recoverable (ENGINEER). The preAction prefills the restore flow with the same clean run, which
// renders the blind-restore proof card, and opens the collapsed "Prove this run restores" disclosure the card
// sits inside so its "?" anchors lay out; three "?"s explain proving recoverability without exposing data.
const proofChapter: TypedTourChapter = {
  route: "/restore",
  title: "Proof it's recoverable",
  preAction: openRestoreProof,
  infoPoints: [
    {
      anchor: "restore-no-data",
      title: "Verify without decrypting to plaintext",
      body:
        "Recoverability is proven, not assumed, and no data is exposed to prove it. The blind restore test decrypts every in-scope record only to check its hash against a discard sink, then returns counts and a digest over those hashes. No record contents are returned, logged or displayed.",
      placement: "bottom",
    },
    {
      anchor: "restore-verify",
      title: "The blind restore drill",
      body:
        "Press this to run a blind restore test against the sealed archive: it confirms every record can be decrypted and verifies its integrity, end to end, without writing a byte back to your live data. The verdict paints here in view, with a restore digest you can record as evidence.",
      placement: "top",
    },
    {
      anchor: "restore-drill",
      title: "Or drill a real sample",
      body:
        "The drill decrypts a sample of records from the sealed archive and checks each one's integrity, then records dated drill evidence, so the trail shows when recoverability was last proven. It restores nothing to your live data and returns no record contents; it is held at the Operator role.",
      placement: "top",
    },
    {
      anchor: "restore-build",
      title: "Try it: build the plan yourself",
      body:
        "This console is real, not a slideshow. Click the button and the engine builds the dry-run restore plan in front of you: every record opened read-only and hash-verified, nothing written. It is the exact review an operator sees before betting a recovery.",
      interact: { label: "click Build the restore plan" },
    },
  ],
};

// When it goes wrong (ENGINEER). The preAction deep-links to the seeded FAILED payments run, opening its
// drawer; two "?"s explain the honest failure surfacing and the recovery move.
const failureChapter: TypedTourChapter = {
  route: "/runs",
  title: "When it goes wrong",
  preAction: () => { navigate(RUN_FAILED); },
  infoPoints: [
    {
      anchor: "run-status",
      title: "A failure surfaced, not hidden",
      body:
        "This run failed, and the console says so plainly. A platform that only ever shows green is hiding the moment that matters; the evaluator's wow here is that it catches problems. The failed run leads the fleet table and the Overview banner, so it is impossible to miss.",
      placement: "right",
    },
    {
      anchor: "run-failure",
      title: "A clear, recoverable reason",
      body:
        "The recorded reason is a coarse, enumerated string, never a stack trace: here the replica bucket policy denied a list during the WORM check, while the primary copy sealed cleanly. So this is a destination-policy fix, and the data is safe on the primary; the operator drills the last good run and reruns.",
      placement: "left",
    },
  ],
};

// Canary flights (ENGINEER). Four "?"s: the live green probe, what a flight checks, the death-preview control (a
// failure shown on-screen in the hero, so the "it catches a bad byte" beat never depends on scrolling to a deep
// history row that the screen's polling re-renders away), and a try-it live flight.
const canaryChapter: TypedTourChapter = {
  route: "/canary",
  title: "Canary flights",
  infoPoints: [
    {
      anchor: "canary-status",
      title: "A live probe, flown on a cadence",
      body:
        "The canary is a synthetic backup flown to every destination on a schedule: it writes known data, seals it, reads it back, restores it and verifies every byte. It is alive now, which means the whole archive path, not just the last real run, is proven healthy end to end.",
      placement: "bottom",
    },
    {
      anchor: "canary-aspects",
      title: "What every flight proves",
      body:
        "Each flight checks the archive path aspect by aspect: the write, the seal and signature, the read-back signature, the byte-exact decrypt integrity, and a delete probe on the destination. A green canary is not a heartbeat; it is a full write-read-verify rehearsal of recovery on known data.",
      placement: "bottom",
    },
    {
      anchor: "canary-preview",
      title: "It catches a bad byte, honestly",
      body:
        "This is what the canary is for. Press Preview a death and the bird takes off, then a single byte strays from the known data and it dies in front of you, all in this browser with nothing sent to the engine. A strayed byte is caught here, before any real backup relies on that path, so you stop trusting that destination until it is investigated.",
      placement: "top",
    },
    {
      anchor: "canary-fly",
      title: "Try it: fly one now",
      body:
        "Go on, press it. A real flight runs in front of you: write, seal, read back, restore, verify, byte for byte. On this sample world it is safe to fly as often as you like, and everything resets when you reload.",
      interact: { label: "click Fly the canary now" },
    },
  ],
};

// Restore under dual control (CTO). Routes straight to the approvals inbox (a real pending request is
// seeded); three "?"s explain the maker/checker gate, the second-approver step, and the signed record.
const dualControlChapter: TypedTourChapter = {
  route: "/restore/approvals",
  title: "Restore under dual control",
  infoPoints: [
    {
      anchor: "approval-maker",
      title: "Optional: require a second approver",
      body:
        "An engineer raised this restore request; this names who. Requiring a second approver on a restore is OPTIONAL: you choose it at setup, and you can run solo. This estate has it on, so the apply is gated on a second authorised approval and the engine enforces maker is not checker on the stable identity, which is why the person who asked can never approve their own restore over production.",
      placement: "right",
    },
    {
      anchor: "approval-approve",
      title: "A distinct second sign-off",
      body:
        "A different Approver or Owner reviews the exact plan, its blast radius and its plan hash, then approves it here. The approval is bound to that one plan hash, so it authorises this restore and nothing else; a re-scoped plan needs a fresh approval.",
      placement: "left",
    },
    {
      anchor: "approval-status",
      title: "Recorded with both identities",
      body:
        "Every step is recorded: the request, the approval and the apply, each as a tamper-evident audit event carrying who did it. With a second approver required, the receipt names both the applier and the distinct approver, so the restore is attributable to two people; with it off, a restore is attributable to the one person who ran it, and every other guard still applies. This is dual control, a second approver inside downpipes; it is separate from change management, the change-number record covered next.",
      placement: "bottom",
    },
  ],
};

// Change management (CTO). Routes to the Reports screen where the Change records report renders (the demo has
// Require Change Number on); ONE "?" draws the line the owner cares about: change management is a RECORD of the
// change number (or a flagged Emergency Change), not a second approver like dual control.
const changeManagementChapter: TypedTourChapter = {
  route: "/reports",
  title: "Change management",
  infoPoints: [
    {
      anchor: "change-record",
      title: "A record, not a second approval",
      body:
        "When Require Change Number is on, every change-controlled action records the operator's ITSM change number here, with who made it and when: a destination repoint, an identity-provider change, a restore apply. Approval still lives in your ITSM; downpipes captures the reference, so this is a record to reconcile against your change system, never a second approver. For a genuine emergency an operator raises an Emergency Change instead: it is not blocked, but it is flagged for retrospective review so the change can be raised in your ITSM after the fact. That is the difference from dual control on the last screen, which is a second person approving inside downpipes.",
      placement: "bottom",
    },
  ],
};

// Evidence (CTO). The Reports screen's signed evidence pack: two "?"s on the heading + the download.
const evidenceChapter: TypedTourChapter = {
  route: "/reports",
  title: "Evidence on demand",
  infoPoints: [
    {
      anchor: "evidence-pack",
      title: "A signed, framework-mapped evidence pack",
      body:
        "Download a signed compliance evidence pack, dated, with each control mapped to a named framework: APRA CPS 230, SEC 17a-4 and DORA among them, plus the live result of the posture checks that evidence it in this deployment. It maps your obligations; it supports your compliance, it does not certify it for you.",
      placement: "bottom",
    },
    {
      anchor: "evidence-download",
      title: "Generated in your account",
      body:
        "The pack is generated in your own account and no report data leaves it. It is a real signed artefact you hand an auditor, not a screenshot: the signature lets them verify it was produced by this deployment and has not been altered since.",
      placement: "top",
    },
  ],
};

// Audit (CTO). The tamper-evident hash-chained audit log: two "?"s on the heading + the verify control.
const auditChapter: TypedTourChapter = {
  route: "/access/audit",
  title: "A tamper-evident audit log",
  infoPoints: [
    {
      anchor: "audit-heading",
      title: "Who did what, append-only",
      body:
        "Every privileged action is recorded here: who, what (redacted of values), when, from where, and the outcome. It is append-only and stored in your own account; the vendor cannot read or alter it. This is the who-did-what record an auditor asks for.",
      placement: "bottom",
    },
    {
      anchor: "audit-verify",
      title: "Verify the chain, end to end",
      body:
        "The log is hash-chained: each entry is hashed together with the prior entry's hash, so a deletion or an edit breaks the chain and is detected. Press this to recompute the chain from the earliest retained entry and confirm it is intact: tamper-evident, verifiable from the head down.",
      placement: "top",
    },
  ],
};

// Identity providers (CTO). The logo-tile grid of SSO providers on the seeded Northwind world: three "?"s on
// the provider breadth, the two live connections, and the optional/additive nature. Every claim matches the
// seed (demo-seed.ts): an Okta SAML connection, a Microsoft Entra OIDC connection, GitHub configured but off.
const idpChapter: TypedTourChapter = {
  route: "/access/idp",
  title: "Identity providers",
  infoPoints: [
    {
      anchor: "idp-providers",
      title: "Bring your own single sign-on",
      body:
        "Your team signs in through the identity provider you already run. SAML 2.0 and OIDC or OAuth2 are native here, laid out as a tile grid: Microsoft Entra, Okta, Google, Keycloak, JumpCloud, Auth0, GitLab, GitHub and a generic OIDC or OAuth2 endpoint. There is no separate identity product to buy or host; a provider in use glows, the rest are one tile away.",
      placement: "bottom",
    },
    {
      anchor: "idp-connection",
      title: "Live connections, no secret shown back",
      body:
        "This sample estate signs in through two live connections, Microsoft Entra over OIDC and Okta over SAML, with a third (GitHub) configured but switched off. Roles and group mappings are applied the same way however a person arrives. A client secret is write-only: you set it and it is never displayed again. downpipes also watches each SAML connection's signing certificate and flags it weeks before it expires, on the Credentials and expiry screen, so sign-in never breaks on a lapsed certificate.",
      placement: "bottom",
    },
    {
      anchor: "idp-add",
      title: "Optional, and purely additive",
      body:
        "An external IdP is for teams that want their existing SSO; it never replaces the basics. Passkeys and the shared token keep working alongside it, so turning on single sign-on adds a way in without taking one away. Pick a tile to add one; roles are still set on the Roles and access tab.",
      placement: "top",
    },
  ],
};

// Notifications (SHARED: CTO and Engineer). Routes to the Rules tab: the routing is the story and the seeded rules name
// the real destinations. Two "?"s: the breadth of on-call/ITSM destinations, and the event-to-channel routing.
// Every claim matches the seed (demo-seed.ts): 5 channels (email, PagerDuty, Slack off, JSM/Opsgenie,
// ServiceNow) and 3 rules (global critical -> PagerDuty+email+JSM, global warning digest -> email, payments).
const notificationsChapter: TypedTourChapter = {
  route: "/notifications/rules",
  title: "Notifications",
  infoPoints: [
    {
      anchor: "notify-rules",
      title: "Alerts route to the tools you already run",
      body:
        "Backups do not just succeed or fail quietly; they tell the on-call tooling you already use. A rule decides which events reach which channels: a global rule is the default, and a per-downpipe rule can override it for one source. downpipes delivers to PagerDuty, Slack, Microsoft Teams, Jira Service Management or Opsgenie, ServiceNow, a generic webhook, or email.",
      placement: "bottom",
    },
    {
      anchor: "notify-routing",
      title: "The right event to the right place",
      body:
        "Each rule fires on events at or above a severity you set. This estate pages the on-call rota over PagerDuty and opens a Jira Service Management ticket the moment a backup or a restore test fails, and emails the platform team as well; the quieter warnings, an expiring credential or a stale backup, digest to a single daily email; and the payments pipe adds its own tighter routing on top.",
      placement: "bottom",
    },
  ],
};

// Integrations (SHARED: CTO and Engineer). The 39-vendor SIEM / observability / ITSM / chat grid, framed for
// both readers (fits your stack; feeds your SIEM). Three "?"s: the breadth, the auto-parse property, and what
// is live now. Every claim matches the seed (demo-seed.ts): a Splunk audit push plus pull/metrics grants and
// notify channels light 16 destinations at once (NOT "only Splunk").
const integrationsChapter: TypedTourChapter = {
  route: "/integrations",
  title: "Integrations",
  infoPoints: [
    {
      anchor: "integrations-grid",
      title: "Feeds the stack you already have",
      body:
        "Every privileged action and backup outcome can stream to the security and observability tools you already run: 39 destinations across SIEM, metrics and observability, incident and on-call, and chat, laid out as one grid. Pick a destination and the wire format it reads is chosen for you; there are no field mappings to build.",
      placement: "bottom",
    },
    {
      anchor: "integrations-autoparse",
      title: "Auto-parses, so nothing is yours to map",
      body:
        "A destination tagged Auto-parses reads downpipes' output in its own native format, with no configuration on either side. Splunk and Datadog take the SIEM feed that way, the incident tools (PagerDuty, Opsgenie, Jira Service Management, ServiceNow) take alerts that way, and Datadog takes OTLP metrics. You connect it; it just understands.",
      placement: "bottom",
    },
    {
      anchor: "integrations-active",
      title: "What is live right now",
      body:
        "This estate already fans out to sixteen destinations at once. Splunk takes the audit push, the last five batches all accepted; pull grants light up Microsoft Sentinel, Cribl and Exabeam; the metrics scrape feeds Prometheus, Grafana, New Relic, Dynatrace, Elastic and Splunk Observability; and PagerDuty, Opsgenie, ServiceNow and email carry the alerts. One backup platform, wired into the tools your teams already watch.",
      placement: "top",
    },
  ],
};

// The funnel close (SHARED). No info-points: the nav-bar renders the two deliberate exits (FUNNEL_CTAS) as real
// anchors, and the visitor leaves for the deploy steps or the enterprise-support pricing page. It lands on the
// Overview backdrop it opened on.
const funnelChapter: TypedTourChapter = {
  route: "/",
  title: "That was the free Community edition",
  infoPoints: [],
  ctas: FUNNEL_CTAS,
  ctaLead: FUNNEL_CTA_LEAD,
};

// ============================================================================================================
// The two curated scripts. Both open on Overview + Sources and close on the funnel; the middle is the reader's.
// ============================================================================================================

// The CTO walk: assurance, governance and ecosystem fit. Ten chapters: no-custody, the source breadth, bring
// your own SSO, restore under dual control, change management, signed evidence, the tamper-evident audit log,
// the notification routing, the integration breadth, and the funnel.
export const ctoChapters: ReadonlyArray<TypedTourChapter> = [
  overviewChapter,
  sourcesChapter,
  idpChapter,
  dualControlChapter,
  changeManagementChapter,
  evidenceChapter,
  auditChapter,
  notificationsChapter,
  integrationsChapter,
  funnelChapter,
];

// The Engineer walk: operate, recover, and wire into your tooling. Ten chapters: no-custody, the source
// breadth, the estate, a backup end to end, proving recoverability, the honest failure, the canary, the
// notification routing, the integration breadth, and the funnel.
export const engineerChapters: ReadonlyArray<TypedTourChapter> = [
  overviewChapter,
  sourcesChapter,
  downpipesChapter,
  backupChapter,
  proofChapter,
  failureChapter,
  canaryChapter,
  notificationsChapter,
  integrationsChapter,
  funnelChapter,
];

// TOUR_SCRIPTS maps the persona the welcome card captures to its curated walk. The launcher reads this to build
// the director over the chosen script; a test drives both. Adding a persona here (and a button on the welcome)
// is the whole cost of a new path, because the director runs any script it is handed.
export const TOUR_SCRIPTS: Readonly<Record<TourPersona, ReadonlyArray<TypedTourChapter>>> = Object.freeze({
  cto: ctoChapters,
  engineer: engineerChapters,
});
