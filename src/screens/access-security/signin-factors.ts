// The SIGN-IN FACTORS panel: who can still sign in to this account, and the control that closes a named
// person's ways in. It sits on the Roles and access tab beside the members table, and it is deliberately a
// SECOND table rather than a column on the first one.
//
// WHY A SECOND TABLE. The members table lists the roster. This one lists everybody who holds a way in, and
// the two are not the same set: an email whose role row was deleted keeps its passkey credentials, its banked
// recovery codes and any unexpired registration invite, because until recently nothing in the engine deleted
// the last two at all. On a real estate, a majority of identities could sign in with no role row, most of them
// through recovery codes, against one identity the roster accounted for. A column on the roster could never
// have shown those 71, because they are not rows in it.
//
// WHY IT IS NOT THE REMOVE BUTTON. Deleting a role row can be a legitimate DEMOTION: the engine resolves a
// member's authority as the maximum of their role row and any identity-provider group claim, so for somebody
// who holds both, deleting the row demotes them and leaves them a working user of the estate. Revoking
// destroys their authenticator and their recovery codes, and recovery codes cannot be re-derived. The engine
// refused to fold the two together because deleteRole cannot tell which one it is being asked for. This panel
// keeps that distinction on screen, in the confirm copy, rather than quietly re-joining them.

import { h, svgIcon } from "../../lib/dom.ts";
import { canCap, canDo, capGateReason, pendingEngineNote, refuseWithReason } from "../common.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { caller } from "../../lib/nav.ts";
import { isUnauthorised, classifyError } from "../../lib/errors.ts";
import { blockError, sessionEnded, errorDetail } from "../../components/error-view.ts";
import { dataTable } from "../../components/data-table.ts";
import { emptyState, skeletonRows } from "../../components/feedback.ts";
import { statusWithLabel, type StatusTone } from "../../components/status.ts";
import { openModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { relativeTime, absoluteTime } from "../../lib/format.ts";
import { ICON_EXTERNAL, ICON_INFO } from "../../lib/icons.ts";
import { closedAWayIn, type EngineClient, type RoleEntry, type SignInFactorListing, type SignInFactorRow, type SignInFactorRevokeResult } from "../../api.ts";
import { noteLine, errText } from "./shared.ts";

// verdictStatus maps the engine's tri-state onto a tone and a label. INDETERMINATE KEEPS ITS OWN ROW and its
// own tone on purpose. The tempting simplification is two states, and it is a lie in one direction: the
// engine's own header says the dangerous failure of this read is the FALSE NEGATIVE, because an operator told
// "no factor" when the truth is "nobody can judge this record" closes the offboarding and walks away while
// the way in stays open. So an unjudgeable record reads as a row to look at, never as a row to skip.
export function verdictStatus(row: SignInFactorRow): { tone: StatusTone; label: string } {
  if (row.signIn === "can-sign-in") return { tone: "warn", label: "can sign in" };
  if (row.signIn === "indeterminate") return { tone: "info", label: "cannot be judged" };
  return { tone: "ok", label: "no way in" };
}

// factorSummary is the plain-language inventory of one row: what this person holds, in the operator's words.
// It reports the recovery arm from the FIELDS rather than from the verdict, because a row can be
// "no-factor" overall and still carry exhausted or refuted codes, and an operator deciding whether to revoke
// is entitled to see that there is a record there at all.
//
// The null unconsumedCodes is rendered as "an unreadable number of" and NEVER as zero. Zero would be the one
// reassuring answer nobody may give about a record nobody could parse.
export function factorSummary(row: SignInFactorRow): string {
  const parts: string[] = [];
  if (row.passkey.credentials > 0) parts.push(`${row.passkey.credentials} passkey ${row.passkey.credentials === 1 ? "credential" : "credentials"}`);
  if (row.recovery.present) {
    if (!row.recovery.parseable) parts.push("a recovery record that could not be read");
    else if (row.recovery.unconsumedCodes === null) parts.push("a recovery record with an unreadable number of codes left");
    else if (row.recovery.unconsumedCodes === 0) parts.push("a recovery record with every code used");
    else if (row.recovery.keyContinuity === "orphaned") parts.push(`${row.recovery.unconsumedCodes} recovery codes that can no longer verify`);
    else if (row.recovery.keyContinuity === "unknown") parts.push(`${row.recovery.unconsumedCodes} recovery codes that cannot be judged`);
    else parts.push(`${row.recovery.unconsumedCodes} usable recovery codes`);
  }
  if (row.invites.live > 0) parts.push(`${row.invites.live} unexpired ${row.invites.live === 1 ? "invite" : "invites"}`);
  if (row.invites.expired > 0) parts.push(`${row.invites.expired} expired ${row.invites.expired === 1 ? "invite" : "invites"}`);
  if (parts.length === 0) return "Nothing in any of the three sign-in stores.";
  return `Holds ${parts.join(", ")}.`;
}

// SELF-REVOCATION, AND WHY THIS GUARD IS HONEST ABOUT BEING A CONSOLE GUARD. Revoking your own every factor is
// a self-lockout with no legitimate use: rotating your own codes is the regenerate action, and dropping a lost
// key is the single-credential revoke. The engine does NOT refuse it -- its own
// comment says the route has "no self-service arm" and that "the guards below cannot save a caller who is
// entitled to lock themselves out", so a roles.write holder who is not the last Owner can strip themselves.
// This console therefore refuses it BEFORE the call, and the refusal is stated as the console's, because a
// mirror that claims to be an engine guard when the engine has none is the false claim this repo exists to
// avoid. The remedy sentence names the two actions that ARE the legitimate versions of this intent.
export const SELF_REVOKE_REASON = "You cannot revoke your own sign-in factors here: it would lock you out with no way back, and recovery codes cannot be re-derived. To replace your codes use Regenerate recovery codes; to drop a lost key remove that one passkey credential.";

// The Owner-row lock. Only an Owner may strip an Owner (the engine's requireNotOwnerEscalation, the same hard
// anti-escalation guard the members table mirrors for its own Remove control). Disabling the control rather
// than offering one that fails server-side is this screen's standing convention.
export const OWNER_ROW_REVOKE_REASON = "Only an Owner may revoke another Owner's sign-in factors.";

// revokeSummary turns the engine's receipt into the sentence the operator reads afterwards. It reports the
// engine's OWN sessionsTerminated verdict rather than re-deriving one from the counts, and it keeps the live
// and expired invite counts apart: folding them would let a revoke that closed nothing report a reassuring
// non-zero total. A sweep of expired residue is stated as exactly that, and it is not a warning.
export function revokeSummary(email: string, result: SignInFactorRevokeResult): { message: string; tone?: "warn" } {
  const r = result.revoked;
  const closed: string[] = [];
  if (r.passkeyCredentials > 0) closed.push(`${r.passkeyCredentials} passkey ${r.passkeyCredentials === 1 ? "credential" : "credentials"}`);
  if (r.recovery) closed.push("their recovery codes");
  if (r.invitesLive > 0) closed.push(`${r.invitesLive} unexpired ${r.invitesLive === 1 ? "invite" : "invites"}`);
  const swept = r.invitesExpired > 0 ? ` ${r.invitesExpired} expired ${r.invitesExpired === 1 ? "invite was" : "invites were"} swept at the same time.` : "";
  if (!closedAWayIn(result)) {
    return { message: `Nothing was closed for ${email}: they held no way in.${swept} Their live sessions were left alone, because none of this signed anybody out.` };
  }
  return { message: `Revoked ${closed.join(", ")} for ${email}. Their live sessions were ended.${swept}` };
}

// renderSignInFactorsPanel is the panel body: the account-wide read, the table, and the per-row control. It is
// built lazily by the Roles tab's disclosure, so the read does not fire until an operator asks for it.
export function renderSignInFactorsPanel(engine: EngineClient): HTMLElement {
  const card = h("section", { class: "card" });
  card.appendChild(
    h(
      "p",
      { class: "field__hint measure", style: "margin-bottom:var(--space-3)" },
      "Every email that can still authenticate to this account, across all three sign-in stores: passkey credentials, banked recovery codes, and unexpired registration invites. Removing somebody's role does not touch any of the three, so a half-finished offboarding shows up here as a person who is no longer on the roster and can still sign in.",
    ),
  );

  const region = h("div", { class: "async-region" });
  card.appendChild(region);

  const load = (): void => {
    region.replaceChildren(skeletonRows(3));
    void Promise.all([
      engine.listSignInFactors(),
      // The OWNER SET, read best-effort and for one purpose: the union read carries hasRoleEntry but never a
      // ROLE, so on its own this panel cannot tell an Owner from anybody else, and the engine hard-refuses a
      // non-Owner caller who tries to strip an Owner. Driven against the real Durable Object,
      // that refusal is a BARE 403 { error: "forbidden" } with no reason in it, which reaches the operator as
      // "your role does not permit this action; the control should be gated before you reach it". So it is
      // gated before they reach it. A failed roles read must never degrade this panel (the engine still
      // enforces the guard either way), so it falls back to an empty set and the control stays live.
      engine.listRoles().catch((): RoleEntry[] => []),
    ])
      .then(([listing, roles]) => region.replaceChildren(buildFactorsTable(engine, listing, roles, load)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the region is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        const cls = classifyError(err);
        const notWired = cls.kind === "server" && (cls.status === 404 || cls.status === 501);
        if (!notWired) {
          region.replaceChildren(blockError(err, load, { origin: location.origin }));
          return;
        }
        // An engine that predates the union read. Say what is MISSING rather than showing an empty table:
        // an empty table here would read as "nobody can sign in", which is the exact false negative this
        // whole surface exists to stop.
        region.replaceChildren(
          pendingEngineNote({
            what: "This engine build does not answer the sign-in factor read, so the console cannot show you who still holds a way in. That is not the same as nobody holding one; treat it as unknown.",
            dependsOn: "the sign-in factor union read (GET /admin/signin-factors)",
            interim: `The engine returned: ${errText(err)}. Until the engine answers it, the roster on this tab is the only view, and the roster does not see credentials, recovery codes or invites.`,
          }),
        );
      });
  };
  load();

  return card;
}

// buildFactorsTable renders the listing. The group-claim caveat rides UNDER the table because it changes how
// the whole table should be read: with mappings configured, an email with no role row may still hold real
// authority through a group claim, so "no role row" is not proof that somebody was offboarded.
function buildFactorsTable(engine: EngineClient, listing: SignInFactorListing, roles: RoleEntry[], reload: () => void): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-3)" });
  const canRevoke = canCap("roles.write");
  const me = caller()?.email ?? null;
  // canDo("owner") is the right test here and canCap("roles.write") is not: access-admin holds roles.write and
  // is still refused an Owner target, which is exactly the discrimination the driven run showed (the same
  // access-admin was allowed the non-owner target seconds later, so the refusal is the escalation guard and
  // not a blanket denial).
  const callerIsOwner = canDo("owner");
  const owners = new Set(roles.filter((r) => r.role === "owner").map((r) => r.email));

  if (listing.factors.length === 0) {
    wrap.appendChild(
      emptyState({
        title: "No email holds a way in",
        body: "The engine found no passkey credential, no recovery record and no unexpired invite for any address on this account. This is the account-wide read, not a filtered one, so it is a real empty rather than an unanswered question.",
      }),
    );
    wrap.appendChild(groupClaimNote(listing.groupRoleMappings));
    return wrap;
  }

  const handle = dataTable<SignInFactorRow>({
    label: "Sign-in factors",
    rows: listing.factors,
    rowKey: (r) => r.email,
    filter: { placeholder: "Filter by email", resultLabel: "identities", getText: (r) => `${r.email} ${r.signIn} ${r.paths.join(" ")}` },
    initialSort: { key: "email", dir: "asc" },
    columns: [
      {
        key: "email",
        header: "Identity",
        sortable: true,
        sortValue: (r) => r.email,
        render: (r) => {
          const cell = h("span", h("span", { class: "mono" }, r.email));
          if (me && r.email === me) cell.appendChild(h("span", { class: "badge badge--accent", style: "margin-left:var(--space-2)" }, "You"));
          return cell;
        },
      },
      {
        key: "verdict",
        header: "Can sign in",
        sortable: true,
        sortValue: (r) => r.signIn,
        render: (r) => {
          const s = verdictStatus(r);
          return statusWithLabel(s.tone, s.label);
        },
      },
      {
        key: "roster",
        header: "On the roster",
        render: (r) =>
          r.hasRoleEntry
            ? h("span", { class: "field__hint" }, "yes")
            : h("span", { class: "field__hint", style: "max-width:26ch" }, "no role row"),
      },
      { key: "holds", header: "Holds", render: (r) => h("span", { class: "field__hint", style: "max-width:44ch;display:inline-block" }, factorSummary(r)) },
      {
        key: "last",
        header: "Passkey last used",
        render: (r) => (r.passkey.lastAssertedAt ? h("span", { title: absoluteTime(r.passkey.lastAssertedAt) }, relativeTime(r.passkey.lastAssertedAt)) : h("span", { class: "field__hint" }, "never")),
      },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        width: "1px",
        render: (r) => revokeAction(engine, r, { canRevoke, me, callerIsOwner, targetIsOwner: owners.has(r.email) }, reload),
      },
    ],
  });
  wrap.appendChild(handle.el);
  wrap.appendChild(groupClaimNote(listing.groupRoleMappings));
  wrap.appendChild(
    noteLine(
      ICON_INFO,
      "Revoking is not the same act as removing a role, and the console keeps them apart. Removing a role can be a demotion for somebody who keeps authority through an identity-provider group; revoking destroys their authenticator and their recovery codes, and recovery codes cannot be re-derived.",
    ),
  );
  return wrap;
}

// groupClaimNote states the GROUP-CLAIM CAVEAT from the engine's own count. The engine holds the group-to-role
// mapping but not the group MEMBERSHIP, so it cannot say whether a given email is in a mapped group; a count is
// the honest form of that fact and a per-row flag would be a fabrication. Zero is the strong answer and is
// worth saying out loud, because it is the one case where "no role row" really does mean no authority.
function groupClaimNote(groupRoleMappings: number): HTMLElement {
  if (groupRoleMappings === 0) {
    return h("p", { class: "field__hint measure" }, "No group-to-role mapping is configured, so nobody on this account can hold a role through an identity-provider group claim. An identity with no role row holds no authority here.");
  }
  return h(
    "p",
    { class: "field__hint measure" },
    `${groupRoleMappings} group-to-role ${groupRoleMappings === 1 ? "mapping is" : "mappings are"} configured. The engine holds the mapping but not the group membership, so it cannot tell you whether a given identity is in a mapped group. An identity with no role row may still hold authority through a group claim, and removing their role row would not have removed it.`,
  );
}

// revokeAction builds the per-row control and its gates. Both locks disable the control and state the reason
// in visible text as well as the title, because a title alone is invisible to keyboard and touch users.
function revokeAction(engine: EngineClient, row: SignInFactorRow, ctx: { canRevoke: boolean; me: string | null; callerIsOwner: boolean; targetIsOwner: boolean }, reload: () => void): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-1);justify-items:end" });
  if (!ctx.canRevoke) {
    wrap.appendChild(h("span", { class: "field__hint" }, capGateReason("roles.write")));
    return wrap;
  }

  const isSelf = ctx.me !== null && row.email === ctx.me;
  // Self first. It is the stricter lock and it is the one this console owns outright: the engine permits
  // self-revocation, so if both applied to the same row the operator must be told the reason that actually
  // stops them here, not the one the engine would have given.
  const lock = isSelf ? SELF_REVOKE_REASON : ctx.targetIsOwner && !ctx.callerIsOwner ? OWNER_ROW_REVOKE_REASON : null;
  const btn = h("button", { "data-dp": "access-security.button.revoke-action", class: "btn btn--ghost btn--sm", type: "button" }, "Revoke sign-in");
  if (lock !== null) {
    refuseWithReason(btn, lock);
  } else {
    btn.addEventListener("click", () => openRevokeModal(engine, row, reload));
  }
  wrap.appendChild(btn);
  if (lock !== null) wrap.appendChild(h("span", { class: "field__hint", style: "max-width:30ch;text-align:right" }, lock));
  return wrap;
}

// openRevokeModal is the confirm ceremony, and its job is to make the consequence honest BEFORE it happens.
//
// It re-reads the person's factors for THIS modal rather than reusing the table row. The table may have been
// on screen for a while, and the whole class of defect this surface exists for is a stale answer read as a
// current one. A failed re-read does not block the action: it says the inventory could not be refreshed and
// falls back to the row, labelled as the older reading, because refusing to let an operator revoke because a
// read failed would leave the door open for the sake of a display.
//
// IT NAMES THE STEP-UP PROMPT, because the engine now opens one: /signin-factors/revoke is in the engine's
// STEPUP_SUBS, so the modal names re-authentication for that reason. Before that route was added to
// STEPUP_SUBS, the modal said nothing about re-authentication, and
// what a customer got in between was an unannounced passkey prompt in the middle of an irreversible
// offboarding action.
//
// The wording is chosen against what the gate actually does rather than against a general idea of step-up.
// requireStepUp runs ONCE, before the router's dispatch switch, so a ceremony that is dismissed or fails
// revokes nothing at all: the operator is not left half-offboarded, and saying so is the difference between
// a prompt that reads as a checkpoint and one that reads as a fault. "May be asked", not "will be", because
// a session that already carries a fresh step-up token satisfies the gate without a second ceremony.
//
// test/validate-signin-factor-revoke.ts section 1b binds this copy to the engine's own Set in BOTH
// directions, so neither side can move again without the other following.
function openRevokeModal(engine: EngineClient, row: SignInFactorRow, reload: () => void): void {
  const email = row.email;
  const body = h("div", { style: "display:grid;gap:var(--space-3)" });
  body.appendChild(
    h(
      "p",
      { style: "color:var(--text)" },
      `Close every way ${email} can sign in? This deletes their passkey credentials, their recovery codes and any registration invite bound to their address, in one audited action, and ends their live sessions.`,
    ),
  );
  body.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "This cannot be undone. Recovery codes cannot be re-derived: if this person needs access again they must be invited afresh and enrol a new passkey. Their role, if they still hold one, is not changed by this, and a role that reaches them through an identity-provider group is unaffected.",
    ),
  );
  body.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is revoked and you can start again from this card.",
    ),
  );

  const inventory = h("div", { class: "async-region" });
  inventory.appendChild(h("p", { class: "field__hint" }, "Checking what they currently hold."));
  body.appendChild(inventory);
  body.appendChild(
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/day-2/offboard-member", target: "_blank", rel: "noreferrer noopener", style: "justify-self:start" },
      "About offboarding a member",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );

  // The fresh single-email read. `?email=` ALWAYS comes back as a row even when all three stores are empty, so
  // an empty listing here is a contract surprise and not a person with nothing: it falls back to the table row
  // rather than rendering a reassuring blank.
  void engine
    .listSignInFactors(email)
    .then((listing) => {
      const fresh = listing.factors.find((f) => f.email === email);
      inventory.replaceChildren(inventoryBlock(fresh ?? row, fresh !== undefined));
    })
    .catch(() => {
      inventory.replaceChildren(inventoryBlock(row, false));
    });

  openModal({
    title: "Revoke sign-in factors",
    body,
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => {} },
      {
        label: "Revoke every factor",
        variant: "danger",
        busyLabel: "Revoking",
        onClick: async () => {
          try {
            const result = await engine.revokeSignInFactors(email);
            toast(revokeSummary(email, result));
            reload();
            return true;
          } catch (err) {
            if (isUnauthorised(err)) {
              goSignedOut();
              return true;
            }
            // The engine's refusals arrive here as prose: the Owner floor (including the raised two-Owner
            // floor while dual control is armed), the Owner-escalation guard, and an address it cannot use.
            // Its sentences are specific to this route and name the deadlock they are avoiding, so they are
            // surfaced rather than replaced with a generic message.
            toast({ message: `Could not revoke the sign-in factors. ${errorDetail(err)}`, tone: "warn" });
            return false;
          }
        },
      },
    ],
  });
}

// inventoryBlock lists what the person holds, and says which reading it is. `current` false means the fresh
// per-email read did not answer, so the figures are the ones the table last saw: an operator about to destroy
// something irreversibly is entitled to know the inventory in front of them might be stale.
function inventoryBlock(row: SignInFactorRow, current: boolean): HTMLElement {
  const block = h("div", { style: "display:grid;gap:var(--space-1)" });
  block.appendChild(h("span", { class: "section-label" }, "What this will destroy"));
  block.appendChild(h("p", { style: "color:var(--text)" }, factorSummary(row)));
  if (row.signIn === "indeterminate") {
    block.appendChild(
      h("p", { class: "field__hint measure" }, "The engine could not judge this recovery record, so it cannot tell you whether a code from it would still work. That is an unanswered question, not a no."),
    );
  }
  block.appendChild(
    current
      ? h("p", { class: "field__hint" }, "Read from the engine just now.")
      : h("p", { class: "field__hint measure" }, "This inventory could not be refreshed just now, so it is the reading the table last took and it may be out of date. The revoke itself acts on whatever the engine finds when it runs."),
  );
  return block;
}
