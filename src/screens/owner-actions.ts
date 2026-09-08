// Owner approvals (the HIGH-BLAST-RADIUS owner-action inbox): the pending owner operations the engine's
// opt-in dual-control gate is holding for a SECOND OWNER to approve. It is the owner-action analogue of the
// config change-control inbox (src/screens/config-changes.ts) and deliberately mirrors that screen's visual +
// interaction pattern: a polled list of cards, each showing the plain-English, redaction-safe summary, who
// proposed it and when, with Approve / Reject actions, and the maker != checker rule made explicit on a
// caller's OWN proposal ("you proposed this; awaiting another owner").
//
// THE GATE (client MIRROR; the engine is the control). When the account requires dual control (the same
// Owner toggle in the Security Centre that arms the config-change gate), a HIGH-BLAST-RADIUS owner operation
// (a destination repoint/add/remove/default, an identity-provider connection change, the account-browsing
// token set, an engine self-deploy, ...) is QUEUED here instead of applying. Approving it runs it (for a
// DO-executed kind) or ARMS it for the proposer to re-submit with a one-shot token (for a router-executed
// kind). The approver MUST be an OWNER and MUST differ from the proposer (maker != checker). Both are
// enforced SERVER-SIDE; this screen mirrors them so the Approve button is never a dead end: it is hidden on a
// caller's own proposal, and the screen itself is surfaced only to an owner.
//
// House rules: read gated on downpipe.read (the read floor; any authenticated role may see the queue, the
// engine shows a non-owner proposer only their OWN proposals), the approve/reject actions are owner-only
// (keys.ceremony) and the engine enforces it. Every server-supplied string (the summary, the proposer email,
// the kind label returned by ownerActionKindLabel) enters the DOM as a text node via the dom.ts h() builder;
// no innerHTML, no inline handlers,
// strict-CSP safe. No-custody: an owner action carries an id, a coarse kind, a redaction-safe summary, a
// proposer email and a timestamp only; the engine strips any live secret from the listing server-side, so a
// credential never reaches this screen.
//
// This module is SELF-OWNED: it exports one screen descriptor; app.ts wires it into SCREENS.

import { ownerActionCodeForError, recordContractSkew, recordOwnerActionRefusal } from "../lib/client-diag/ring.ts";
import type { ClientDiagAdminOp, ClientDiagOwnerActionCode } from "../lib/client-diag/vocab.ts";
import { errorStatus, forbiddenClass } from "../lib/errors.ts";
import { h, svgIcon } from "../lib/dom.ts";
import {
  pageHeader, requireEngine, defineScreen, collapsedSection, type Screen, type ScreenContext,
} from "./common.ts";
import { goSignedOut, caller, navigate } from "../lib/nav.ts";
import { isUnauthorised, classifyError, isStepUpRequired } from "../lib/errors.ts";
import { blockError, sessionEnded, stepUpAwareText } from "../components/error-view.ts";
import { skeletonRows, emptyState } from "../components/feedback.ts";
import { confirmModal } from "../components/modal.ts";
import { toast } from "../components/toast.ts";
import { badge, type StatusTone } from "../components/status.ts";
import { relativeTime } from "../lib/format.ts";
import { ICON_CHECK, ICON_CLOSE, ICON_SHIELD_CHECK } from "../lib/icons.ts";
import { ownerActionKindLabel, isKnownOwnerActionKind, isMineOwnerAction, callerCanApproveOwnerAction } from "../lib/owner-actions.ts";
import type { EngineClient, OwnerAction, OwnerActionStatus } from "../api.ts";

// The route the owner-action approval inbox owns (the high-blast-radius owner-action surface). It sits under
// /security because dual control is armed from the Security Centre.
export const ROUTE_OWNER_ACTIONS = "/security/owner-actions";

export const ownerActionsScreen: Screen = defineScreen({
  route: ROUTE_OWNER_ACTIONS,
  title: "Owner approvals",
  measure: "wide",
  // The screen-owned palette command: navigate to the owner-action approval inbox. Surfaced only to a role
  // that can APPROVE an owner action (an owner; the inbox itself enforces owner-only via the engine). A
  // non-owner has nothing to action here, so the gate is owner.
  actions: [
    {
      id: "owner-actions.open",
      title: "Review pending owner approvals",
      group: "Actions",
      kind: "navigate",
      keywords: ["owner", "approval", "approve", "dual control", "four eyes", "destination", "identity provider", "high blast", "pending"],
      target: ROUTE_OWNER_ACTIONS,
      when: ({ caller: c }) => callerCanApproveOwnerAction(c),
    },
  ],
  render(_ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;
    return renderOwnerActions(engine);
  },
});

function renderOwnerActions(engine: EngineClient): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Owner approvals",
      "High-blast-radius owner actions awaiting a second owner under dual control (also called four-eyes). The approver must be an owner and must differ from whoever proposed the action (maker is not checker).",
      undefined,
      // Reached mid-task from a "queued for a second owner" toast or the Security centre's gate toggle, so a
      // referrer-aware crumb returns the owner to where they were, the Security centre on a cold arrival.
      { label: "Security centre", to: "/security" },
    ),
  );

  // The "where do I turn this on or off?" line, as a real navigating link (not plain copy that sent owners
  // hunting). Deep-links straight to the Security Centre toggle (opens + scrolls to it).
  root.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin-top:calc(-1 * var(--space-2))" },
      "Turn this requirement on or off in ",
      h("button", { "data-dp": "owner-actions.button.navigate-security-open-dual-control", class: "linklike", type: "button", on: { click: () => navigate("/security?open=dual-control") } }, "Dual control (Security centre)"),
      ".",
    ),
  );

  const region = h("div", { class: "async-region" });
  root.appendChild(region);

  mountOwnerActionsRegion(engine, root, region);
  return root;
}

// The silent-poll cadence (ms): re-fetch the owner-action list this often so a newly queued
// action appears without a manual reload. Mirrors the config-change inbox poll.
const OWNER_ACTIONS_POLL_MS = 15_000;

// mountOwnerActionsRegion drives the async region's data lifecycle: the initial load, the focus-safe
// repaint (a poll repaints only when the (id, status) set changed, so a steady poll never eats focus
// from an Approve/Reject button mid-interaction), the not-yet-wired-engine vs transport-fault split,
// and the ~15s silent poll that stops when the screen detaches and hands off to goSignedOut on a
// sign-out. `root` is the connectedness anchor for the poll; `region` is where the list paints.
function mountOwnerActionsRegion(engine: EngineClient, root: HTMLElement, region: HTMLElement): void {
  const me = caller()?.email ?? null;
  const meSubject = caller()?.subject ?? null;

  let renderedSig: string | null = null;
  const sigOf = (actions: OwnerAction[]): string => actions.map((a) => `${a.id}:${a.status}`).sort().join("|");
  const paint = (actions: OwnerAction[]): void => {
    renderedSig = sigOf(actions);
    const ctx: RenderCtx = { engine, me, meSubject, reload: load };
    region.replaceChildren(renderList(ctx, actions));
  };

  const load = (): void => {
    region.replaceChildren(skeletonRows(3));
    renderedSig = null;
    void engine
      .listOwnerActions()
      .then((actions) => paint(actions))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the owner-action queue is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(() => load()));
          return goSignedOut();
        }
        // Distinguish a not-yet-wired engine (404/501: the owner-action routes are absent on this build)
        // from a genuine transport fault (5xx / network) where a Retry is appropriate, mirroring the
        // config-change inbox degrade.
        const kind = classifyError(err, { origin: location.origin });
        if (kind.kind === "server" && (kind.status === 404 || kind.status === 501)) {
          region.replaceChildren(
            emptyState({
              title: "Dual control is not enabled on this engine",
              body: "This engine build does not expose the owner-action dual-control gate yet. When it does, high-blast-radius owner actions proposed while the requirement is on will appear here for a second owner.",
            }),
          );
        } else {
          region.replaceChildren(blockError(err, () => load(), { origin: location.origin }));
        }
      });
  };

  // Silent poll: never blanks the list on a poll fault (only a successful fetch updates the region);
  // stops when detached; a sign-out on the poll still hands off to goSignedOut.
  const pollTick = window.setInterval(() => {
    if (!root.isConnected) { window.clearInterval(pollTick); return; }
    void engine.listOwnerActions().then((actions) => {
      if (!root.isConnected) return;
      // Skip the repaint when the (id, status) set is unchanged, so a steady poll never eats focus.
      if (sigOf(actions) === renderedSig) return;
      paint(actions);
    }).catch((err: unknown) => {
      if (isUnauthorised(err)) { window.clearInterval(pollTick); goSignedOut(); }
    });
  }, OWNER_ACTIONS_POLL_MS);

  load();
}

// RenderCtx bundles the per-render dependencies the card renderers thread through together (the engine
// client, the caller's identity used for the maker-is-not-checker cue, and the reload callback), so each
// renderer takes a single context object instead of repeating the same parameter quartet.
interface RenderCtx {
  engine: EngineClient;
  me: string | null;
  meSubject: string | null;
  reload: () => void;
}

function renderList(ctx: RenderCtx, actions: OwnerAction[]): HTMLElement {
  // The engine's listing returns only PENDING and ARMED (approved-but-not-yet-executed) actions, so a "non
  // pending" row here is an armed router-executed action awaiting the proposer's token re-submit. Pending
  // first (the actionable ones), then the armed ones, so the queue leads with what needs a decision.
  const pending = actions.filter((a) => a.status === "pending");
  const others = actions.filter((a) => a.status !== "pending");
  if (actions.length === 0) {
    return emptyState({
      title: "No owner approvals waiting",
      body: "When dual control is on, a high-blast-radius owner action (repointing or removing a destination, changing an identity-provider connection, setting the account-browsing token, and so on) is queued here for a second owner instead of applying immediately. There is nothing waiting right now.",
    });
  }
  const list = h("div", { class: "approval-list" });
  for (const a of pending) {
    list.appendChild(renderActionCard(ctx, a));
  }
  if (pending.length === 0) {
    list.appendChild(h("p", { class: "field__hint" }, "Nothing is awaiting approval."));
  }
  // Armed actions (approved, awaiting the proposer's token re-submit) collapse so the pending cards are the
  // whole eager view; the context stays one click away rather than growing an unbounded scroll.
  if (others.length > 0) {
    const armed = h("div", { class: "approval-list" });
    for (const a of others) armed.appendChild(renderActionCard(ctx, a));
    list.appendChild(collapsedSection(`Approved, awaiting the proposer (${others.length})`, armed));
  }
  return list;
}

function renderActionCard(ctx: RenderCtx, action: OwnerAction): HTMLElement {
  const mine = isMineOwnerAction(action, ctx.meSubject, ctx.me);
  // G302: an owner-action kind this console build has no label for renders its RAW id in the card heading, and
  // that heading is asking an owner to authorise it. The console has never said anywhere that it did not
  // recognise the operation, so a version-skewed pair (an engine proposing an action a newer console names) is
  // indistinguishable from a console defect. The kind STRING never rides: it is an engine-supplied id and, on a
  // tampered record, an arbitrary one.
  if (!isKnownOwnerActionKind(action.kind)) recordContractSkew("unknown-enum-member", "owner-action-kind");
  const card = h("div", { class: "card approval-card" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h3", { class: "card__title" }, svgIcon(ICON_SHIELD_CHECK, { size: 16 }), ownerActionKindLabel(action.kind)),
      actionStatusBadge(action.status),
    ),
  );

  // Who + when cues (the maker, the time, and when it expires), mirroring the config-change cue row.
  const cues = h("div", { class: "approval-cues" });
  cue(cues, "Proposed by", action.proposedBy);
  cue(cues, "Proposed", relativeTime(action.proposedAt));
  cue(cues, "Expires", relativeTime(action.expiresAt));
  card.appendChild(cues);

  // The plain-English, redaction-safe summary the engine pre-rendered (host/bucket/scope/connection id only,
  // never a secret), as a text node (no markup).
  card.appendChild(renderSummary(action.summary));

  if (action.status === "pending") {
    card.appendChild(renderActionActions(ctx, action, mine));
  } else if (action.status === "approved") {
    // An armed router-executed action: a second owner approved it; it runs when the proposer re-submits the
    // original request with a one-shot token. An owner may still veto it before it executes.
    card.appendChild(
      h("p", { class: "field__hint" }, action.approvedBy
        ? `Approved by ${action.approvedBy}. It runs when the proposer re-submits the original request. You can still reject it before it does.`
        : "Approved. It runs when the proposer re-submits the original request. You can still reject it before it does."),
    );
    card.appendChild(rejectButton(ctx, action, REJECT));
  }
  return card;
}

// renderSummary renders the engine's plain-English action description as a TEXT NODE (never parsed as
// markup), so a summary that mentions a destination host / bucket / connection id cannot inject anything. A
// blank summary degrades to an honest note rather than an empty box.
function renderSummary(summary: string): HTMLElement {
  const wrap = h("div", { class: "card card--inset", style: "margin-top:var(--space-3);display:grid;gap:var(--space-1)" });
  wrap.appendChild(h("p", { class: "field__hint", style: "margin-bottom:var(--space-1)" }, "What this does"));
  const text = summary.trim();
  if (text === "") {
    // G289: the same shape as the unapprovable change above, on the owner-action surface: the operator is asked
    // to authorise something the engine declined to describe.
    recordContractSkew("empty-payload", "action-summary");
    wrap.appendChild(h("p", { style: "color:var(--text)" }, "The engine did not provide a description for this action."));
    return wrap;
  }
  wrap.appendChild(h("p", { class: "mono", style: "color:var(--text);white-space:pre-wrap;margin:0" }, text));
  return wrap;
}

function renderActionActions(ctx: RenderCtx, action: OwnerAction, mine: boolean): HTMLElement {
  const actions = h("div", { class: "approval-actions" });

  // Maker is not checker: a caller cannot approve their OWN proposal. Shown as the explicit awaiting-state,
  // NOT a dead disabled button. The proposer may still withdraw (reject) their own. One hint line, not a
  // banner: three own proposals must not stack three identical banners.
  if (mine) {
    actions.appendChild(
      h("p", { class: "field__hint" }, "You proposed this; awaiting a different owner to approve (maker is not checker)."),
    );
    actions.appendChild(rejectButton(ctx, action, WITHDRAW));
    return actions;
  }

  // Approving is owner-only and the engine enforces it; the screen is surfaced only to an owner, so a
  // non-owner reaching it by deep link sees the engine's refusal surfaced inline on click (never a silent
  // dead end). We therefore always offer Approve on someone else's pending action and defer the authority to
  // the engine, exactly as the config-change inbox defers an unknown-kind approve to the engine.
  actions.appendChild(approveButton(ctx, action));
  actions.appendChild(rejectButton(ctx, action, REJECT));
  return actions;
}

// refusalCode classifies a REFUSED owner-action call (G300) from what the code can actually establish: the ONE
// status the engine varies, the identity whoami resolved, and the console's re-read of its own inbox. The engine's
// refusal prose is never read. It cannot be classified honestly and must not be: the engine words a self-approval
// and an expiry the same three digits apart, and any classifier over that text guesses wrong the moment the engine
// rewords itself.
//
//   not-owner          THE ENGINE'S ROUTE CAPABILITY GATE said so, and it is the ONE 403 that names the caller as
//                      the one refused (its body carries the `required` capability and the `have` role). It covers
//                      the owner DEMOTED with the card still on their screen (the inbox repaints only when the
//                      (id, status) signature changes, so their Approve button survives the demotion).
//   engine-authz-refused the engine refused on authority WITHOUT naming a capability (the DO's AuthError funnel,
//                      whose public body is the bare "forbidden" by design). Not the same claim: on an approve the
//                      live producer is the PROPOSER having lost owner, and the caller is a good second owner.
//   engine-csrf        the engine's CSRF check refused. Nobody's authority is in question, and it is not about
//                      this action: with CONSOLE_ORIGIN unset every cookie-borne save in the console is 403ing.
//   edge-blocked       the 403 body is no refusal this engine emits (a WAF block page, a proxy): the call was
//                      stopped in front of the engine, which may never have seen it.
//   identity-unresolved the refusal landed with no resolved identity at all. Said plainly, never as not-owner.
//   expired            the action's expiry passed underneath the operator: nobody rejected it, it will never run.
//   already-decided    a SECOND owner decided it underneath this operator (rejected it, ran it, or approved it and
//                      left it ARMED for the proposer's re-submit). Opposite remedy to expired.
//   bare-token         the caller is the ADMIN_TOKEN break-glass, which has no attributable identity; dual control
//                      refuses it by design and no second owner can ever be that caller.
//   self-approval      the caller IS the proposer. It looks unreachable (the screen offers no Approve on your own
//                      proposal) and it is not: isMineOwnerAction is false whenever whoami has not resolved, so a
//                      caller with an unresolved identity is offered Approve on their own action.
//
// THE AUTHORITY AXIS IS TESTED BEFORE THE LIFECYCLE, AND THE FATE IS READ ONLY FOR AN OWNER. The
// fate used to be tested FIRST, off a listing that is CALLER-SCOPED: canRequesterSeeOwnerAction (engine
// src/admin/owner-action.ts) shows an OWNER every record and shows everybody else only their OWN proposals. So a
// non-owner's re-read cannot contain the action they just tried to approve, absence was true by construction, and
// their permissions refusal was recorded as `already-decided`: "a second owner rejected or ran it, go and read the
// audit", about an action that was still pending and that nobody had decided. Two of the three states that
// coalesced into that row were false. The fate is now consulted only where absence is a FACT (an owner's listing
// is complete), and the engine's own 403 decides the authority axis.
//
// A 401 never reaches here: the caller routes it to signed-out first, and recording a lapsed session as a
// dual-control refusal would fabricate a governance fault every time one expires.
//
// IT READS THE IDENTITY FRESH, AT CLICK TIME, AND THIS IS THE WHOLE POINT. The screen captures me/meSubject ONCE
// at mount and threads them unchanged into every card, so classifying a refusal from those captured values asks
// the same question, of the same null identity, that let the Approve button render in the first place: if
// isMineOwnerAction had been true at mount, renderActionActions would have returned Withdraw and there would be
// no Approve button to refuse. Re-deriving "am I the proposer" from the stale copy can therefore only ever
// answer false, which is why self-approval had no producer on the approve path and the genuine maker-checker
// refusal was being filed as a generic engine-refused. whoami resolves asynchronously; by the time the operator
// clicks, the identity that was null at mount usually IS resolved, and it is the one the engine just judged.
//
// Under the 403 the remaining axes run in the ENGINE'S OWN refusal order (canApproveOwnerAction): the record's
// state, then the bare token, then maker-is-checker. A self-approval row against a long-dead proposal would name a
// remedy (find a second owner) for an action no second owner can now approve.
//
// self-approval is gated to the APPROVE op: reject deliberately does NOT require maker != checker (withdrawing
// your own proposal is the designed use of it), so a refused Withdraw is never a self-approval violation, and
// labelling it one would put a governance fault in the pack for a legitimate state.
//
// IT TAKES THE LISTING, NOT A FATE, and that too is a fix: the suite used to hand it a hand-made fate ("still
// pending", for a viewer looking at somebody else's action) that the real pipeline cannot return for that caller,
// and proved the classifier against a state the product cannot reach. The fate is now derived HERE, from the
// caller the console holds and the listing the engine served, so a test has to supply the listing the engine
// would.
export function refusalCode(
  op: ClientDiagAdminOp,
  action: OwnerAction,
  err: unknown,
  listing: OwnerAction[] | null,
  nowMs: number,
): ClientDiagOwnerActionCode | null {
  const coarse = ownerActionCodeForError(err);
  if (coarse !== "engine-refused") return coarse; // null (Access lapse), unreachable or answer-unreadable: settled
  // THE 403 IS DECIDED BY THE BODY SHAPE, NOT BY THE STATUS, and it is decided BEFORE the
  // identity is consulted, because two of the four 403s are not about the identity at all. A CSRF-origin 403 and
  // a WAF block page both refuse an operator whose identity the console may not even have resolved yet, and
  // filing them as identity-unresolved would be the same fabrication one axis further along.
  const forbidden = forbiddenClass(err);
  if (forbidden === "engine-capability") return "not-owner"; // the route gate named the capability: THIS caller
  if (forbidden === "engine-authz") return "engine-authz-refused"; // the DO refused on authority, naming nothing
  if (forbidden === "engine-csrf") return "engine-csrf"; // the perimeter, not the person: every save is 403ing
  if (forbidden === "not-engine-body") return "edge-blocked"; // no engine refusal shape: something in front of it
  const who = caller(); // FRESH, not the mount-time capture
  if (who === null) return "identity-unresolved"; // no identity to judge by: say so, do not guess at not-owner
  const fate = ownerActionFateFromListing(action, callerCanApproveOwnerAction(who) ? listing : null, nowMs);
  if (fate === "expired") return "expired";
  if (fate === "decided") return "already-decided";
  if (who.email === null) return "bare-token"; // the break-glass token: attributable identity required, by design
  if (op === "owner-action-approve" && isMineOwnerAction(action, who.subject ?? null, who.email)) return "self-approval";
  return "engine-refused";
}

// OwnerActionFate is what the inbox says became of the action, re-read AFTER the refusal (G300). `unknown` is the
// honest answer when the re-read faulted, when the caller's listing could not contain the action anyway, or when
// the record's expiry will not parse: it records nothing about the fate, and refusalCode then falls through to the
// remaining axes rather than asserting a lifecycle fact.
export type OwnerActionFate = "still-pending" | "expired" | "decided" | "unknown";

// ownerActionFateFromListing reads the fate off the inbox the engine just served. It is pure, it is exported, and
// the validator drives it. Pass listing = null whenever the listing cannot answer for this action: a faulted
// re-read, or a caller whose scoped listing would not have contained it in the first place.
//
// A LISTED RECORD IS READ BY ITS STATUS, NOT BY ITS EXPIRY. GET /admin/owner-actions lists pending and approved
// records only, and applies LAZY EXPIRY on the way out (effectiveOwnerActionStatus + the filter in
// scheduler-do-dual-control.ts), so the engine never lists an effective-expired record and a listed record's own
// status is the engine's latest word on it. `approved` means a SECOND OWNER HAS ALREADY APPROVED IT and it is
// ARMED for the proposer's one-shot re-submit: a decision, not a pending action, and reading only presence and
// expiry (as this did) filed that state in the residual. An unknown status from a newer engine answers `unknown`
// rather than being coerced into one of ours.
//
// GONE FROM AN OWNER'S LISTING is a terminal state, and the two have opposite remedies: an expiry means nobody
// decided it and the proposer must propose it again; anything else means a second owner rejected or ran it and the
// audit says who. The record's own expiresAt (RFC-3339, on the record the console is looking at) tells them apart,
// through a SHAPE GATE and not a trusting parse: an expiresAt that will not parse to a finite epoch answers
// `unknown`, because a NaN comparison silently answers "not expired" and would file every unparseable record as a
// decision nobody made.
export function ownerActionFateFromListing(action: OwnerAction, listing: OwnerAction[] | null, nowMs: number): OwnerActionFate {
  if (listing === null) return "unknown"; // the re-read faulted, or it could not have answered: establish nothing
  const live = listing.find((a) => a.id === action.id);
  if (live !== undefined) {
    if (live.status === "pending") return "still-pending";
    if (live.status === "approved" || live.status === "executed" || live.status === "rejected") return "decided";
    if (live.status === "expired") return "expired";
    return "unknown"; // a status this build does not know: do not coerce it into one of ours
  }
  const expiresMs = Date.parse(action.expiresAt);
  if (!Number.isFinite(expiresMs)) return "unknown"; // gone, and the record cannot say why: do not guess
  return expiresMs <= nowMs ? "expired" : "decided";
}

// noteRefusal records ONE owner-action refusal. Split out so both buttons record identically and neither can
// drift from the other. It re-reads the inbox only when the engine REFUSED with something other than its authority
// 403, and only for a caller whose listing is COMPLETE (an owner): a dead transport has no fate to read, a lapsed
// Access session records nothing at all, and a non-owner's caller-scoped listing cannot contain somebody else's
// action, so re-reading it would establish nothing and asserting anything from it would be a fabrication. No fault
// path adds a call to a hot loop.
async function noteRefusal(engine: EngineClient, op: ClientDiagAdminOp, action: OwnerAction, err: unknown): Promise<ClientDiagOwnerActionCode | null> {
  if (errorStatus(err) === 401) return null; // an ordinary lapsed session, handled by the signed-out route
  const coarse = ownerActionCodeForError(err);
  if (coarse === null) return null; // an Access-redirect: the overnight tab, not a governance refusal
  let listing: OwnerAction[] | null = null;
  if (coarse === "engine-refused" && errorStatus(err) !== 403 && callerCanApproveOwnerAction(caller())) {
    listing = await engine.listOwnerActions().catch(() => null);
  }
  const code = refusalCode(op, action, err, listing, Date.now());
  if (code !== null) recordOwnerActionRefusal(op, code);
  return code;
}

// refusalToastMessage is the CUSTOMER-FACING half of refusalCode's classification: a sentence the operator
// can act on without a raw "<verb>: forbidden-class=...: 403" transport string, and without disclosing
// anything the code above deliberately keeps closed (who else holds Owner, whether a capability exists).
// Every branch mirrors the remedy already reasoned out in CLIENT_DIAG_OWNER_ACTION_CODES's own comments
// (vocab.ts) so the wording here cannot drift from the classification it describes. `label` is the verb the
// operator just pressed ("Approve" / "Reject" / "Withdraw"), lower-cased into the sentence.
function refusalToastMessage(label: string, code: ClientDiagOwnerActionCode | null): string {
  const verb = label.toLowerCase();
  switch (code) {
    case "self-approval":
      return `You proposed this action, so a different owner needs to ${verb} it (maker is not checker). Wait for another owner, or withdraw it yourself.`;
    case "not-owner":
      return "Your role no longer permits this action. Reload the page to see your current role and permissions.";
    case "expired":
      return "This action expired before anyone approved it, so nothing ran. Propose it again if it is still needed.";
    case "already-decided":
      return "Another owner already acted on this since the page loaded. Reload to see the current state, and check the audit log for what happened.";
    case "identity-unresolved":
      return "Your identity had not finished loading when you pressed this. Reload the page and try again.";
    case "bare-token":
      return "The break-glass token has no attributable identity, so it cannot approve or reject owner actions. Sign in with a named identity (Cloudflare Access or a passkey) and try again.";
    case "engine-authz-refused":
      return `Could not ${verb}: the engine refused on authority grounds. The proposer may have lost the Owner role since this was raised; reload to see the current state.`;
    case "engine-csrf":
      return "Your session could not be verified for this save. Reload the page and sign in again; if it keeps happening on every save, the engine's CONSOLE_ORIGIN setting may not match this console.";
    case "edge-blocked":
      return "The request was blocked before it reached the engine, most likely by a network or proxy rule in front of it. Retry; if it keeps happening, check for a blocking rule on your own network or Cloudflare account.";
    case "answer-unreadable":
      return `The engine accepted the ${verb}, but its response could not be read. Reload the inbox to see whether it went through before trying again.`;
    // "engine-refused" (a residual 400/429/500), "unreachable" (no answer at all) and null (an
    // Access-redirect noteRefusal already dropped) all share the same honest, non-overclaiming
    // fallback: this classifier establishes nothing more specific for any of them.
    default:
      return `Could not ${verb} this action. Retry, and if it keeps happening, reload the page.`;
  }
}

function approveButton(ctx: RenderCtx, action: OwnerAction): HTMLButtonElement {
  const { engine, reload } = ctx;
  const btn = h("button", { "data-dp": "owner-actions.button.approve-button", class: "btn btn--primary btn--sm", type: "button" }, svgIcon(ICON_CHECK, { size: 14 }), "Approve") as HTMLButtonElement;
  // Single-dispatch guard on the dual-control boundary: a rapid double-click before the
  // confirmation modal opens must not stack two modals nor issue two approveOwnerAction
  // calls (mirrors the overview drillInFlight guard, finding console-src-043-10).
  let approvalInFlight = false;
  btn.addEventListener("click", async () => {
    if (approvalInFlight) return;
    approvalInFlight = true;
    try {
      const ok = await confirmModal({
        title: "Approve owner action",
        body: `Approve "${ownerActionKindLabel(action.kind)}"? You may be asked to confirm with your own passkey first. If you dismiss that prompt, or it fails, nothing is approved and you can start again. Once that check is done the approval is recorded with both identities (the proposer and you), and every action runs at that point except a router-executed one (such as an engine update), which waits for the proposer to re-submit with their one-shot token.`,
        confirmLabel: "Approve",
        busyLabel: "Approving",
      });
      if (!ok) return;
      await engine.approveOwnerAction(action.id);
      toast({ message: "Owner action approved" });
      reload();
    } catch (err) {
      // G300: the refusal rides in the pack as a closed code BEFORE the toast that dies with it. The engine
      // audits the approvals that SUCCEED, so a refused one leaves no audit event and no config event: the
      // proposal sits in the inbox looking untouched, and "nobody rejected it and it just vanished" is a ticket
      // the pack agrees with. Recorded for the sign-out case too? No: noteRefusal drops a 401 itself.
      const code = await noteRefusal(engine, "owner-action-approve", action, err);
      if (isUnauthorised(err)) return goSignedOut();
      // The engine refuses a self-approval (maker == checker) or a non-owner approver; refusalToastMessage
      // translates the closed code noteRefusal just classified into a customer sentence, never the raw
      // "<verb>: forbidden-class=...: 403" transport string.
      //
      // BUT NOT FOR THE STEP-UP STATE, and it is the one this button reaches most easily. Approve is step-up
      // gated (router.ts:594 gates the parsed "approve" action; reject beside it is not), so a dismissed
      // passkey prompt lands here with a 401. noteRefusal drops every 401 as a lapsed session, so `code` is
      // null, and null falls to the default arm: "Retry, and if it keeps happening, reload the page." Reloading
      // does nothing for this, and the operator is never told the prompt is what they missed.
      if (isStepUpRequired(err)) {
        toast({ message: `This action was not approved. ${stepUpAwareText(err)}`, tone: "warn" });
        return;
      }
      toast({ message: refusalToastMessage("Approve", code), tone: "warn" });
    } finally {
      approvalInFlight = false;
    }
  });
  return btn;
}

// RejectVariant carries the button label and the success toast's past tense. Both variants call
// rejectOwnerAction, which sets the engine status to "rejected"; the toast therefore reports "rejected"
// for both so the message matches the engine-recorded status and the status badge (finding
// console-src-043-11). Only the two shipped variants are valid (finding console-src-043-07).
type RejectVariant =
  | { label: "Reject"; past: "rejected" }
  | { label: "Withdraw"; past: "rejected" };

const REJECT: RejectVariant = { label: "Reject", past: "rejected" };
const WITHDRAW: RejectVariant = { label: "Withdraw", past: "rejected" };

function rejectButton(ctx: RenderCtx, action: OwnerAction, variant: RejectVariant): HTMLButtonElement {
  const { engine, reload } = ctx;
  const { label, past } = variant;
  const btn = h("button", { "data-dp": "owner-actions.button.reject-button", class: "btn btn--secondary btn--sm", type: "button" }, svgIcon(ICON_CLOSE, { size: 14 }), label) as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: `${label} owner action`,
      body: `${label} "${ownerActionKindLabel(action.kind)}"? It will not be carried out.`,
      confirmLabel: label,
      variant: "danger",
      busyLabel: `${label}ing`,
    });
    if (!ok) return;
    try {
      await engine.rejectOwnerAction(action.id);
      toast({ message: `Owner action ${past}` });
      reload();
    } catch (err) {
      // G300, the other half. A reject that the engine turned down for a TERMINAL state is the "it vanished"
      // ticket seen from the other end: the operator went to withdraw their own proposal and it had already
      // expired out from under them. Nothing anywhere records that today.
      const code = await noteRefusal(engine, "owner-action-reject", action, err);
      if (isUnauthorised(err)) return goSignedOut();
      toast({ message: refusalToastMessage(label, code), tone: "warn" });
    }
  });
  return btn;
}

// cue appends one label/value pair to a cue row (a definition-list-like inline pair), value as a text node.
function cue(host: HTMLElement, label: string, value: string): void {
  host.appendChild(
    h("div", { class: "approval-cue" },
      h("span", { class: "approval-cue__label field__hint" }, label),
      h("span", { class: "approval-cue__value" }, value),
    ),
  );
}

// actionStatusBadge maps an owner-action status to a toned badge (pending = info, approved/armed = warn since
// it is not yet done and still needs the proposer's token, the rest neutral), mirroring the config-change
// status badge. The listing only ever returns pending/approved, but the map is total for safety.
function actionStatusBadge(status: OwnerActionStatus): HTMLElement {
  const map: Record<OwnerActionStatus, { tone: StatusTone; label: string }> = {
    pending: { tone: "info", label: "Awaiting approval" },
    approved: { tone: "warn", label: "Approved, awaiting the proposer" },
    executed: { tone: "ok", label: "Carried out" },
    rejected: { tone: "danger", label: "Rejected" },
    expired: { tone: "neutral", label: "Expired" },
  };
  const m = map[status];
  return badge(m.tone, m.label);
}
