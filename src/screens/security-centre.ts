// Security centre (build contract section 7 + section 9 console surfaces): the posture
// score, the severity-ranked checks each naming the standard control it maps to and the
// remediation to fix it, the coverage / gap detection, and the Owner-only access controls
// (the four-eyes dual-control toggle, the recovery codes and the break-glass token). The
// posture is a pure computation over the account's own observable state; the vendor reads
// nothing.
//
// House rules carried through:
//   - No-custody: a check carries names, a status, a control reference, an observed detail
//     and a remediation only; never a secret, key or value. Every server-supplied string
//     enters the DOM via textContent / typed element creation (dom.ts).
//   - Capability gating: the risk-accept / unaccept and the access controls are gated with
//     can(caller.role, ...) - the CLIENT MIRROR of the engine's server-side gate. The engine
//     is ALWAYS the enforcement point; a gated control is shown disabled-with-reason, never
//     hidden-then-403. The reads are any authenticated role.
//   - Precise claims: tamper-evident (never tamper-proof); post-quantum hybrid (never
//     quantum-proof). A risk-accepted check is stated as an accepted risk, not a pass.
//
// This file is the COORDINATOR: it owns the screen descriptor (route, title, measure, render) and the two
// independent async regions + the two access-control disclosures, and re-exports the symbols external callers
// (the security-centre / recovery-ui / config-changes validators) depend on. The posture render lives in
// ./security-centre/posture.ts; the coverage pure helpers + render in ./security-centre/coverage.ts; the
// four-eyes and recovery/break-glass controls in ./security-centre/access.ts; the shared pure grading and the
// small presenters in ./security-centre/shared.ts. The file was split for size while keeping the public
// surface byte-identical.
//
// CSP / CSSOM: styles via h() + node.style.setProperty (the dom.ts builder), never setAttribute("style").

import type { CoverageResourceType, EngineClient } from "../api.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { noteQuiet, skeletonRows } from "../components/feedback.ts";
import { type Field, field } from "../components/field.ts";
import { openModal } from "../components/modal.ts";
import { toast } from "../components/toast.ts";
import { recordInputDropped } from "../lib/client-diag/ring.ts";
import { h } from "../lib/dom.ts";
import { isUnauthorised } from "../lib/errors.ts";
import { goSignedOut } from "../lib/nav.ts";
import { surfacePendingChange } from "../lib/pending-change-toast.ts";
import { autoRefreshToggle, getAutoRefresh } from "../lib/refresh-pref.ts";
import {
  collapsedSection,
  pageHeader,
  requireEngine,
  type Screen,
  type ScreenContext,
} from "./common.ts";
import { configApprovalControl, recoveryAccessControl } from "./security-centre/access.ts";
import { changeNumberControl } from "./security-centre/change-management.ts";
import type { PopulateInventory } from "./security-centre/coverage.ts";
import { COVERAGE_INVENTORY_TYPES, coverageTypeLabel, inventoryLinesDropped, parseInventory, renderCoverage } from "./security-centre/coverage.ts";
import { renderPosture } from "./security-centre/posture.ts";
import { restoreApprovalControl } from "./security-centre/restore-approval.ts";
import { callerCanCap, ROUTE_SECURITY } from "./security-centre/shared.ts";
import { signInContextControl } from "./security-centre/signin-context.ts";

export {
  configApprovalControl,
  RECOVERY_CODES_LOW_AT,
  recoveryCountTone,
  renderRecoveryAccess,
  retireRefuseText,
} from "./security-centre/access.ts";
export {
  COVERAGE_CARDS_PER_GROUP,
  COVERAGE_INVENTORY_TYPES,
  type CoverageFinding,
  compareCoverageResources,
  coverageFindings,
  coverageStatement,
  coverageStatusLabel,
  coverageStatusOrder,
  coverageStatusTone,
  coverageTypeLabel,
  type PopulateInventory,
  parseInventory,
  parseInventoryGroup,
  renderCoverage,
} from "./security-centre/coverage.ts";
// Re-exports: the security-centre, recovery-ui and config-changes validators import the pure posture grading,
// the coverage helpers + render, the recovery-access render and the break-glass refuse-text helper BY NAME
// from this module, so the split keeps every one of those imports working unchanged. The pure helpers live in
// the ./security-centre/shared.ts and ./security-centre/coverage.ts leaves (DOM-free where they can be);
// re-exporting them here keeps the public import surface of screens/security-centre.ts byte-identical.
export {
  compareChecks,
  isNeedsAttention,
  isOverriddenStatus,
  overrideKindHelp,
  overrideKindLabel,
  scoreStatus,
  severityRank,
  severityTone,
  statusOrder,
  statusTone,
} from "./security-centre/shared.ts";
export { signInContextControl } from "./security-centre/signin-context.ts";

// ---------------------------------------------------------------------------
// The screen descriptor. measure:"wide" because the checks
// read as a dense, severity-ranked control list. The palette command lives in
// shell/registry.ts (per the task), so this descriptor contributes none here.
// ---------------------------------------------------------------------------

export const securityCentreScreen: Screen = {
  route: ROUTE_SECURITY,
  title: "Security centre",
  measure: "wide",
  actions: [],
  render(ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    // The auto-refresh pause (WCAG 2.2.2): the posture region polls in place, so the operator can
    // stop it. Same header control as the other polling screens.
    root.appendChild(
      pageHeader(
        "Security centre",
        "Your recoverability and access posture, scored and mapped to named controls. Each check states what was observed, how it is decided, and how to fix it, and you can grade what the platform cannot verify (attest a pass, record a compensating control, mark N/A, or accept a risk). The score is computed in your own account over your own state; the vendor reads nothing.",
        h("div", { class: "page-header__actions" }, autoRefreshToggle()),
      ),
    );

    // The question this screen answers: "what is my posture,
    // and what needs fixing?" The score + failing checks are the eager work surface;
    // the standing claims framing is ONE quiet line (the header desc already carries
    // the in-your-own-account claim); the two policy CONTROLS (four-eyes, recovery
    // codes/break-glass) demote behind collapsed disclosures BELOW the posture read,
    // their bodies still render and load (state is one open away), and anything
    // urgent about them surfaces through the checks.
    const claims = noteQuiet(h("p", "Encryption is post-quantum hybrid and the audit trail is tamper-evident: detectable if altered, never tamper-proof."));
    claims.style.setProperty("margin-top", "var(--space-5)");
    root.appendChild(claims);

    // A deep link (?open=dual-control|change-number|signin-context) must scroll to the section's FINAL
    // position, which only settles once BOTH async regions above it (posture, coverage) have replaced
    // their skeleton with loaded content or a retryable error, whichever grows the page more. Firing the
    // scroll at construction time, against the short skeleton, targets a position the page then scrolls
    // past as the regions load (the original bug: the scroll landed at scrollY 0 and never re-fired).
    // Track each region's first settle and fire the scroll once both are in.
    let postureSettled = false;
    let coverageSettled = false;
    let deepLinkTarget: HTMLElement | null = null;
    const maybeScrollDeepLink = (): void => {
      if (postureSettled && coverageSettled && deepLinkTarget) {
        deepLinkTarget.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    };

    root.appendChild(buildPostureRegion(engine, () => { postureSettled = true; maybeScrollDeepLink(); }));
    root.appendChild(buildCoverageRegion(engine, () => { coverageSettled = true; maybeScrollDeepLink(); }));
    const accessControls = buildAccessControls(engine, ctx);
    root.appendChild(accessControls.el);
    deepLinkTarget = accessControls.deepLinkTarget;

    return root;
  },
};

// buildPostureRegion builds the eager posture async region: a skeleton, then the scored posture (or a
// retryable block error). It owns its own self-referential load closure so a retry re-runs the same
// fetch, and a standing 30-second poll (the house cadence) keeps the screen current while it is
// visible: the engine recomputes the posture live on every read, so what this screen shows is only as
// fresh as its last fetch. The poll refreshes IN PLACE (no skeleton flash), pauses while the tab is
// hidden or the operator paused auto-refresh (WCAG 2.2.2), and a stray post-unmount timer exits
// without rescheduling.
//
// The optional onSettled fires once, the first time the initial load resolves (success or a retryable
// error either way replaces the skeleton and fixes the region's height). render() uses it to know when a
// deep-link scroll below this region can safely target its final position; a later poll or a manual
// retry never re-fires it.
function buildPostureRegion(engine: EngineClient, onSettled?: () => void): HTMLElement {
  const region = h("div", { class: "async-region", style: "margin-top:var(--space-5)" });
  const POLL_MS = 30_000;
  let pollTimer: number | undefined;
  let settled = false;
  const signalSettled = (): void => {
    if (settled) return;
    settled = true;
    onSettled?.();
  };
  const schedulePoll = (): void => {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => {
      pollTimer = undefined;
      if (!region.isConnected) return;
      if (getAutoRefresh() === "paused" || document.hidden) {
        schedulePoll(); // paused/hidden: do not fetch, just keep ticking at the steady cadence
        return;
      }
      loadSilent();
    }, POLL_MS);
  };
  // loadSilent refreshes in place: the current render stays up until the fresh one arrives (a poll
  // must never flash a skeleton over a screen the operator is reading). A poll fault keeps the
  // current render and just re-arms (the manual Refresh and the eager load surface errors).
  const loadSilent = (): void => {
    void engine
      .getPosture()
      .then((report) => {
        region.replaceChildren(renderPosture(engine, report, load));
        schedulePoll();
      })
      .catch((err) => {
        if (isUnauthorised(err)) return goSignedOut();
        schedulePoll();
      });
  };
  const load = (): void => {
    region.replaceChildren(skeletonRows(6));
    void engine
      .getPosture()
      .then((report) => {
        region.replaceChildren(renderPosture(engine, report, load));
        schedulePoll();
        signalSettled();
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the posture region is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          signalSettled();
          return goSignedOut();
        }
        region.replaceChildren(blockError(err, load, { origin: location.origin }));
        signalSettled();
      });
  };
  load();
  return region;
}

// buildCoverageRegion builds the SECOND, independent async region (build contract section 7 + section 9):
// which resources are protected, which exist but are not backed up, and which are backed up but never
// proven recoverable. It loads independently of the posture so one failing does not blank the other. The
// "Populate inventory" affordance is offered only to an access.policy caller, mirroring the engine's
// server-side gate (the engine is always the enforcement point; this mirror is UX).
//
// The optional onSettled mirrors buildPostureRegion's: fires once, on the first load's settle (success or
// a retryable error), so render() can time a deep-link scroll below this region correctly.
function buildCoverageRegion(engine: EngineClient, onSettled?: () => void): HTMLElement {
  const coverageRegion = h("div", { class: "async-region", style: "margin-top:var(--space-6)" });
  let settled = false;
  const signalSettled = (): void => {
    if (settled) return;
    settled = true;
    onSettled?.();
  };
  const loadCoverage = (): void => {
    coverageRegion.replaceChildren(skeletonRows(4));
    void engine
      .getCoverage()
      .then((report) => {
        coverageRegion.replaceChildren(renderCoverage(report, loadCoverage, populate));
        signalSettled();
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the coverage region is a skeleton until this replaces it.
          coverageRegion.replaceChildren(sessionEnded(loadCoverage));
          signalSettled();
          return goSignedOut();
        }
        coverageRegion.replaceChildren(blockError(err, loadCoverage, { origin: location.origin }));
        signalSettled();
      });
  };
  const populate: PopulateInventory | undefined = callerCanCap("access.policy")
    ? { onClick: () => openPopulateInventoryModal(engine, loadCoverage) }
    : undefined;
  loadCoverage();
  return coverageRegion;
}

// buildAccessControls builds the two access-posture CONTROLS. The dual control toggle is a thing
// owners come here to find (Settings and the change-requests inbox both point at it), so its heading names
// it in full and it presents OPEN by default; the engine still enforces Owner-only writes regardless of who
// can see it. A deep link (/security?open=dual-control) opens it. The recovery-codes control stays
// collapsed (its weight is demoted, not its findability).
//
// Returns the container plus the deep-linked section (if the ?open= query named one), rather than
// scrolling to it here: render() only scrolls once the async posture and coverage regions above these
// controls have settled, since scrolling here, against their still-short skeleton, would land short of
// the final target.
function buildAccessControls(engine: EngineClient, ctx: ScreenContext): { el: HTMLElement; deepLinkTarget: HTMLElement | null } {
  const controls = h("div", { class: "stack-sm", style: "margin-top:var(--space-6)" });
  const dualControl = collapsedSection(
    "Dual control (four-eyes): require a second approver for config changes",
    configApprovalControl(engine),
    { open: true },
  );
  dualControl.id = "dual-control";
  controls.appendChild(dualControl);
  // The RESTORE half of dual control, presented OPEN beside the config half because the two are independent
  // policies that share a name: one gates a config mutation, this one gates a write-back over live data. It
  // is off by default; the gate used to be unconditional, which left a one-identity estate unable to apply a
  // restore at all. A deep link (/security?open=restore-approval) opens it.
  const restoreApproval = collapsedSection(
    "Dual control for restores: require a second approver before a restore is applied",
    restoreApprovalControl(engine),
    { open: true },
  );
  restoreApproval.id = "restore-approval";
  controls.appendChild(restoreApproval);
  // The change-management requirement (owner opt-in): owners come here to enable it, so it presents OPEN by
  // default like the dual-control toggle. A deep link (/security?open=change-number) opens it.
  const changeNumber = collapsedSection(
    "Require a change number for change-controlled actions (change management)",
    changeNumberControl(engine),
    { open: true },
  );
  changeNumber.id = "change-number";
  controls.appendChild(changeNumber);
  // The unusual-location sign-in notification (owner opt-in): collapsed by default (it is a
  // notify preference, not a governance gate); a deep link (/security?open=signin-context) opens it.
  const signInContext = collapsedSection(
    "Notify on a sign-in from a new location",
    signInContextControl(engine),
  );
  signInContext.id = "signin-context";
  controls.appendChild(signInContext);
  controls.appendChild(collapsedSection("Recovery codes and break-glass", recoveryAccessControl(engine)));

  // Deep link: /security?open=dual-control|change-number|signin-context opens the matching section
  // synchronously (the body is rendered eagerly by collapsedSection, so this is safe before either async
  // region above has loaded). This is how Settings, the change-requests inbox and owner-actions hand the
  // owner straight to the right toggle; render() scrolls to the returned element once it can do so safely
  // (once the async regions above have settled, so the scroll targets the section's final position).
  const open = ctx.query.get("open");
  let deepLinkTarget: HTMLElement | null = null;
  if (open === "dual-control") { (dualControl as HTMLDetailsElement).open = true; deepLinkTarget = dualControl; }
  if (open === "restore-approval") { (restoreApproval as HTMLDetailsElement).open = true; deepLinkTarget = restoreApproval; }
  if (open === "change-number") { (changeNumber as HTMLDetailsElement).open = true; deepLinkTarget = changeNumber; }
  if (open === "signin-context") { (signInContext as HTMLDetailsElement).open = true; deepLinkTarget = signInContext; }

  return { el: controls, deepLinkTarget };
}

// inventoryTypeHint is the per-type one-line guidance shown above each textarea: what native identifier
// to paste for that resource type. Australian English, precise, no hype.
function inventoryTypeHint(type: CoverageResourceType): string {
  switch (type) {
    case "kv": return "One per line: the KV namespace id, optionally followed by a comma and a label.";
    case "r2": return "One per line: the R2 bucket name, optionally followed by a comma and a label.";
    case "d1": return "One per line: the D1 database id or binding, optionally followed by a comma and a label.";
    case "secrets": return "One per line: the Secrets Store secret name, optionally followed by a comma and a label.";
  }
}

// inventoryTypePlaceholder is a real "<id>, <label>" example line per resource type, shown in the empty
// textarea so the paste shape (one resource per line, id then an optional comma-label) is obvious without
// restating the hint. The values are illustrative only; the operator pastes their own account's resources.
function inventoryTypePlaceholder(type: CoverageResourceType): string {
  switch (type) {
    case "kv": return "9f3c2a1b4d5e6f7089a0b1c2d3e4f5a6, sessions";
    case "r2": return "app-assets, production media";
    case "d1": return "app_db, orders database";
    case "secrets": return "STRIPE_SECRET_KEY, billing";
  }
}

// openPopulateInventoryModal builds the populate-inventory modal: one textarea per resource type (the
// operator pastes the resources that EXIST in their account, one per line as "<id>" or "<id>, <label>"),
// parses them client-side into a ResourceInventory and POSTs it to /admin/coverage/inventory. On success
// it confirms the stored per-type counts and reloads the gap view so the new rows appear; an engine
// refusal (a malformed/oversized inventory, HTTP 400) surfaces verbatim via a toast and keeps the modal
// open so the operator can correct it. The engine is the authority on validation and the access.policy
// gate; this surface never sends a value or a key (an inventory carries only ids and labels).
// Exported for the validator: the queued-202 branch below is reachable only through this modal's Save, and
// the screen render around it needs a live coverage report, so the validator opens the modal directly.
export function openPopulateInventoryModal(engine: EngineClient, reload: () => void): void {
  const fields = new Map<CoverageResourceType, Field>();
  const body = h("div", { style: "display:grid;gap:var(--space-4)" });
  body.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "Record the resources that exist in your account so the gap view can show which are not yet backed up. This is reference data only: it never grants data access and is never used on a backup or restore path. Paste one resource per line; an empty group means you have none of that type.",
    ),
  );
  for (const type of COVERAGE_INVENTORY_TYPES) {
    const f = field({
      id: `coverage-inventory-${type}`,
      label: coverageTypeLabel(type),
      kind: "textarea",
      placeholder: inventoryTypePlaceholder(type),
      hint: inventoryTypeHint(type),
      doc: { href: "https://docs.downpipes.io/assurance-audit/coverage", anchor: "recording-the-inventory-from-the-console" },
    });
    fields.set(type, f);
    body.appendChild(f.el);
  }

  openModal({
    title: "Populate coverage inventory",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Save inventory",
        variant: "primary",
        busyLabel: "Saving",
        onClick: async () => {
          const groups = {
            kv: fields.get("kv")?.control.value ?? "",
            r2: fields.get("r2")?.control.value ?? "",
            d1: fields.get("d1")?.control.value ?? "",
            secrets: fields.get("secrets")?.control.value ?? "",
          };
          // A pasted inventory line with no id is silently skipped, so the saved roster is smaller than the
          // paste and the coverage grid then measures coverage against a list with a hole in it. The operator sees
          // a success toast carrying a count they have no reason to check. Counts only; no id and no label rides.
          const drops = inventoryLinesDropped(groups);
          recordInputDropped("coverage-inventory-paste", drops.accepted, drops.dropped);
          const inventory = parseInventory(groups);
          const result = await engine.setCoverageInventory(inventory);
          // QUEUED, NOT SAVED. Storing the inventory is a change-controlled mutation, so with the approval
          // gate armed the engine answers 202 and stores nothing. This branch used to be absent: the queued
          // answer carries no `counts`, so the destructure below threw a raw TypeError over a request the
          // engine had accepted, and the operator saw a crash rather than "queued for approval".
          if (result.status === "pending") {
            surfacePendingChange("inventory");
            return;
          }
          const { kv, r2, d1, secrets } = result.value.counts;
          toast({ message: `Inventory saved (${kv} KV, ${r2} R2, ${d1} D1, ${secrets} secrets).`, tone: "success" });
          reload();
        },
      },
    ],
  });
}
