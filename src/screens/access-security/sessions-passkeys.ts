// Sessions and passkeys section of the Access and security area's fallback sub-view (ASVS
// V7.4.5 (L2) / V7.5.2 (L2) PARTIAL / V6.5.6 (L3, implemented)): self-service session termination, the caller's own passkey
// inventory, and the admin session levers (sign out a member, sign out everyone). Extracted
// from fallback.ts so each cohesive block sits under its own module; the logic is byte-for-byte
// the same. The fallback panel imports sessionsAndPasskeysSection and renders it under
// "This session". statusLine is the shared read-only posture row from ./shared.ts.

import { h, svgIcon } from "../../lib/dom.ts";
import { canDo, canCap, gateReason, capGateReason, collapsedSection } from "../common.ts";
import { goSignedOut, signOut } from "../../lib/nav.ts";
import { isUnauthorised, classifyError } from "../../lib/errors.ts";
import { field, validateForm } from "../../components/field.ts";
import { confirmModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { skeletonRows, emptyState } from "../../components/feedback.ts";
import { blockError, sessionEnded, refusalText } from "../../components/error-view.ts";
import { relativeTime } from "../../lib/format.ts";
import { ICON_REFRESH, ICON_ALERT, ICON_KEYS, ICON_MONITOR, ICON_TRASH } from "../../lib/icons.ts";
import type { EngineClient, PasskeyCredentialSummary } from "../../api.ts";
import { statusLine } from "./shared.ts";

// ===========================================================================
// Sessions and passkeys (ASVS V7.4.5 (L2) / V7.5.2 (L2) PARTIAL / V6.5.6 (L3, implemented))
// ===========================================================================

// refusedMessage composes the operator-facing copy for an engine REFUSAL of a privileged access-control
// action: the reviewed sentence for what the refusal was, then the local capability hint as context.
//
// IT USED TO SPLICE errText RAW so "the engine's own reason leads", and both premises under that are gone.
// It is called on ONE path, the `forbidden` branch of the two admin session levers, and (1) since the 403
// shape gate the transport folds a CLOSED CLASS into a 403 throw and never the body's words, so errText here
// was "terminate member sessions: forbidden-class=engine-capability: 403" and a customer read a console
// classifier token; (2) the escalation/last-Owner guards it was written to preserve answer 400, not 403
// (engine src/admin/client-diag-vocab.ts says so), so their reason never travelled through here at all. It
// arrives on the callers' OTHER branch, which goes through refusalText too. refusalText is the reviewed rule:
// the engine's sentence when it gave one, the classified kind's when it did not. Exported so a validator pins it.
export function refusedMessage(err: unknown, hint: string): string {
  return `${refusalText(err)} ${hint}`;
}

export function sessionsAndPasskeysSection(engine: EngineClient): HTMLElement {
  const wrap = h("section", { class: "stack", style: "display:grid;gap:var(--space-5);margin-top:var(--space-5)", "aria-labelledby": "sessions-passkeys-h" });
  wrap.appendChild(
    h(
      "div",
      { style: "display:grid;gap:var(--space-1)" },
      h("h2", { id: "sessions-passkeys-h", style: "font-size:var(--text-lg)" }, "Sessions and passkeys"),
      h("p", { class: "field__hint measure" }, "Sign out your other sessions, manage your enrolled passkeys, and (for admins) end a member's sessions or sign everyone out. The engine enforces these; revoking a passkey or ending sessions takes effect on the next request."),
    ),
  );

  const grid = h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:var(--space-5)" });
  grid.appendChild(selfSessionsCard(engine));
  grid.appendChild(passkeysCard(engine));
  wrap.appendChild(grid);

  // The admin levers are the rarely-used break-glass surface, so they collapse (7a) rather than
  // standing expanded at full width; the gating (disabled-with-reason) is unchanged inside.
  wrap.appendChild(collapsedSection("Admin: sign out members", adminSessionsCard(engine), { tone: "danger" }));
  return wrap;
}

// selfSessionsCard is the self-service "sign out my other sessions" (V7.5.2 PARTIAL: the list-and-
// terminate exists, but the engine route is not step-up gated, so the V7.5.2 re-authentication
// prerequisite is unmet; see client-session.ts terminateOtherSessions), available to any authenticated
// user. The engine re-issues THIS session's cookie, so the current tab stays signed in; a bare-token
// caller has no first-party session and the engine refuses (surfaced honestly).
function selfSessionsCard(engine: EngineClient): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "self-sessions-h" });
  card.appendChild(h("div", { class: "card__header" }, h("h3", { class: "card__title", id: "self-sessions-h" }, h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-2)" }, svgIcon(ICON_MONITOR, { size: 16 }), "Your other sessions"))));
  card.appendChild(h("p", { class: "field__hint measure" }, "Sign out every other session for your account on other browsers and devices. This session stays signed in; the engine re-issues this session's cookie."));

  const btn = h("button", { "data-dp": "access-security.button.self-sessions-card", class: "btn btn--secondary", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Sign out my other sessions") as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Sign out your other sessions",
      body: "This signs out every other session for your account, on other browsers and devices. This session stays signed in. Continue?",
      confirmLabel: "Sign out other sessions",
      busyLabel: "Signing out",
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await engine.terminateOtherSessions();
      toast({ message: "Your other sessions were signed out. This session stays active." });
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      // The bare-token "no first-party session" refusal is a 400, not a role denial: refusalText keeps the
      // engine's honest reason and keeps the transport's own folded tokens out of what a customer reads.
      toast({ message: `Could not sign out your other sessions. ${refusalText(err)}`, tone: "warn" });
    } finally {
      btn.disabled = false;
    }
  });
  card.appendChild(h("div", { style: "margin-top:var(--space-3)" }, btn));
  return card;
}

// passkeysCard lists the CALLER'S OWN enrolled passkeys (V6.5.6, L3) with a revoke action per key. Any
// authenticated user manages their own. The engine's sole-Owner-last-passkey guard refuses the last key
// of the only Owner; that refusal is surfaced verbatim. Loading / empty / error are distinct states.
function passkeysCard(engine: EngineClient): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": "passkeys-h" });
  card.appendChild(h("div", { class: "card__header" }, h("h3", { class: "card__title", id: "passkeys-h" }, h("span", { style: "display:inline-flex;align-items:center;gap:var(--space-2)" }, svgIcon(ICON_KEYS, { size: 16 }), "Your passkeys"))));
  card.appendChild(h("p", { class: "field__hint measure" }, "The WebAuthn passkeys enrolled for your account. Revoke one you no longer use or that was on a lost device; revoking a passkey also signs out sessions that predate it."));

  const region = h("div", { class: "async-region", style: "margin-top:var(--space-3)" });
  card.appendChild(region);

  // load is named so a successful revoke can re-fetch in place (the list never offers a just-revoked key).
  const load = (): void => {
    region.replaceChildren(skeletonRows(2));
    void engine
      .listPasskeyCredentials()
      .then((res) => region.replaceChildren(passkeyList(engine, res.credentials, load)))
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the passkey list is a skeleton until this replaces it.
          region.replaceChildren(sessionEnded(load));
          return goSignedOut();
        }
        region.replaceChildren(blockError(err, load));
      });
  };
  load();
  return card;
}

// passkeyList renders the credential rows (or the empty state) with a revoke button per key. The COSE
// alg and the AAGUID are shown as coarse, honest labels; the credential id is shown abbreviated (it is a
// long opaque public handle). Every server string reaches the DOM via h() (escaped).
function passkeyList(engine: EngineClient, creds: PasskeyCredentialSummary[], reload: () => void): HTMLElement {
  if (creds.length === 0) {
    return emptyState({
      title: "No passkeys enrolled",
      body: "You have no WebAuthn passkeys enrolled for this account on this engine. Enrol one from the sign-in screen to use passkey authentication.",
    });
  }
  const wrap = h("div", { style: "display:grid;gap:var(--space-2)" });
  for (const c of creds) {
    const row = h("div", { class: "card card--inset", style: "display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4)" });
    const left = h(
      "div",
      { style: "display:grid;gap:2px;min-width:0" },
      h("span", { class: "mono", style: "overflow:hidden;text-overflow:ellipsis", title: c.credentialId }, abbreviateId(c.credentialId)),
      h("span", { class: "field__hint" }, `Enrolled ${relativeTime(c.createdAt)} · ${coseAlgLabel(c.alg)}${c.transports.length ? ` · ${c.transports.join(", ")}` : ""}`),
    );
    const revokeBtn = h("button", { "data-dp": "access-security.button.revoke", class: "btn btn--ghost btn--sm", type: "button" }, svgIcon(ICON_TRASH, { size: 14 }), "Revoke") as HTMLButtonElement;
    revokeBtn.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: "Revoke this passkey",
        body: `Revoke this passkey (${abbreviateId(c.credentialId)})? It can no longer sign in, and sessions that predate it are signed out. You cannot undo this; you would enrol a fresh passkey to replace it. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is revoked and you can start again from this row.`,
        confirmLabel: "Revoke passkey",
        variant: "danger",
        busyLabel: "Revoking",
      });
      if (!ok) return;
      revokeBtn.disabled = true;
      try {
        const res = await engine.deletePasskeyCredential(c.credentialId);
        if (res.deleted) toast({ message: "Passkey revoked." });
        else toast({ message: "That passkey was already gone.", tone: "info" });
        reload();
      } catch (err) {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: a lapsed session must not leave this row's Revoke stuck off.
          revokeBtn.disabled = false;
          return goSignedOut();
        }
        // The sole-Owner-last-passkey 400 still rides verbatim; the raw splice does not. It read "revoke
        // passkey: forbidden-class=engine-capability: 403" on a 403, the second-surface trap the walk named.
        revokeBtn.disabled = false;
        toast({ message: `Could not revoke this passkey. ${refusalText(err)}`, tone: "warn" });
      }
    });
    row.appendChild(left);
    row.appendChild(revokeBtn);
    wrap.appendChild(row);
  }
  return wrap;
}

// adminSessionsCard holds the two admin session levers, each gated to the right capability with the
// existing disabled-with-reason pattern: "sign out a member's sessions" (roles.write; owner AND
// access-admin) and the destructive "sign out everyone / rotate the session key" (owner only). The engine
// enforces both; this mirror only governs what the console offers.
function adminSessionsCard(engine: EngineClient): HTMLElement {
  // The wrapping disclosure's summary carries the "Admin: sign out members" heading.
  const card = h("section", { class: "card" });
  card.appendChild(h("p", { class: "field__hint measure" }, "End another member's sessions, or sign everyone out by rotating the session signing key. These are administrative session controls; the engine enforces who may run them."));
  card.appendChild(memberSessionsAction(engine));
  card.appendChild(h("hr", { style: "border:none;border-top:1px solid var(--border-subtle);margin:var(--space-4) 0" }));
  card.appendChild(allSessionsAction(engine));
  return card;
}

// memberSessionsAction is the "sign out a member's sessions" lever (roles.write; the engine's
// owner-escalation guard means an Owner's sessions may be ended only by an Owner). Disabled-with-reason
// when the caller lacks the capability; the engine enforces the gate regardless.
function memberSessionsAction(engine: EngineClient): HTMLElement {
  const canManageOthers = canCap("roles.write");
  const memberWrap = h("div", { style: "display:grid;gap:var(--space-3);margin-top:var(--space-4)" });
  memberWrap.appendChild(h("h4", { style: "font-size:var(--text-md);margin:0" }, "Sign out a member's sessions"));
  if (!canManageOthers) {
    memberWrap.appendChild(h("p", { class: "field__hint" }, capGateReason("roles.write")));
    return memberWrap;
  }
  memberWrap.appendChild(h("p", { class: "field__hint measure" }, "End every session for one member, by email. They are signed out on their next request and must sign in again. An Owner's sessions can only be ended by an Owner."));
  const emailField = field({
    id: "terminate-user-email",
    label: "Member email",
    type: "email",
    placeholder: "ops@acme.example",
    hint: "The member's verified sign-in email, lowercased. Ends every session for that account; an Owner's sessions can only be ended by an Owner.",
    doc: { href: "https://docs.downpipes.io/identity-access/session-management", anchor: "sign-out-a-members-sessions" },
    autocomplete: "off",
    validate: (v) => (v.trim() === "" ? "Enter the member's email." : null),
  });
  memberWrap.appendChild(emailField.el);
  const btn = h("button", { "data-dp": "access-security.button.member-sessions-action", class: "btn btn--secondary", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Sign out this member") as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    if (!validateForm([emailField])) return;
    const email = emailField.value().trim();
    const ok = await confirmModal({
      title: "Sign out this member",
      body: `End every session for ${email}? They are signed out on their next request and must sign in again. This is immediate and audited. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is signed out and you can start again.`,
      confirmLabel: "Sign out this member",
      busyLabel: "Signing out",
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await engine.terminateUserSessions(email);
      toast({ message: `Signed out all sessions for ${email}.` });
      emailField.control.value = "";
    } catch (err) {
      if (isUnauthorised(err)) return goSignedOut();
      // A 403 here can be the role gate OR the owner-escalation guard, and the engine says WHICH in its
      // reason. The old copy threw that reason away and asserted the role gate, so an operator refused by
      // the escalation guard was told the wrong story and support had no trace of the right one. The
      // engine's own reason now leads; the capability hint follows as context, never as a substitute.
      const kind = classifyError(err);
      if (kind.kind === "forbidden") toast({ message: refusedMessage(err, capGateReason("roles.write")), tone: "warn" });
      else toast({ message: `Could not sign out this member. ${refusalText(err)}`, tone: "warn" }); // the 400 guards land HERE; refusalText keeps their words
    } finally {
      btn.disabled = false;
    }
  });
  memberWrap.appendChild(h("div", btn));
  return memberWrap;
}

// allSessionsAction is the destructive "sign out everyone / rotate the session signing key" lever
// (owner only). It ends every session including the caller's own, so a success routes to the signed-out
// screen. Disabled-with-reason for non-owners; the engine enforces the gate regardless.
function allSessionsAction(engine: EngineClient): HTMLElement {
  const isOwner = canDo("owner");
  const allWrap = h("div", { style: "display:grid;gap:var(--space-3)" });
  allWrap.appendChild(h("h4", { style: "font-size:var(--text-md);margin:0;color:var(--danger-fg)" }, "Sign out everyone"));
  if (!isOwner) {
    allWrap.appendChild(h("p", { class: "field__hint" }, gateReason("owner")));
    allWrap.appendChild(h("p", { class: "field__hint measure" }, "Signing everyone out rotates the session signing key, which ends every session including your own and invalidates every member's recovery codes. It is Owner only."));
    return allWrap;
  }
  allWrap.appendChild(
    statusLine(
      "warn",
      "This signs out everyone, including you",
      "Rotating the session signing key ends every outstanding session across all members and both auth methods. It also invalidates every member's recovery codes, which are verified with that same key, so regenerate them once you are back in. Use it as a break-glass after a suspected session compromise, and you will need to sign in again.",
    ),
  );
  const btn = h("button", { "data-dp": "access-security.button.all-sessions-action", class: "btn btn--danger", type: "button" }, svgIcon(ICON_ALERT, { size: 14 }), "Sign out everyone") as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Sign out everyone",
      body: "This rotates the session signing key, signing out every member (including you) on their next request. It also invalidates every member's recovery codes, which share that key, so you will need to regenerate them afterwards. Use it only as a break-glass after a suspected session compromise. You may be asked to confirm with your own passkey before this runs. If you dismiss that prompt, or it fails, nothing is signed out and you can start again. Continue?",
      confirmLabel: "Sign out everyone",
      variant: "danger",
      busyLabel: "Signing out",
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await engine.terminateAllSessions();
      // The caller's own session is now invalid too, and this is a deliberate, terminal end (not a lapsed
      // session that might recover by re-auth), so it takes the REAL signOut() -- clearing the caller,
      // engine client and entity/search caches -- rather than goSignedOut()'s bare re-route, which would
      // otherwise leave the just-ended operator's identity and cached fleet data readable from this tab.
      toast({ message: "Everyone was signed out and the session key was rotated. That also invalidated every member's recovery codes; regenerate them, and sign in again to continue." });
      // PAINT FIRST, THEN LEAVE, on the SUCCESS path too. The lever stays disabled, which is correct (the
      // rotation happened and offering it again would invite a second one), but it must not stay disabled
      // under the resting label as though nothing had occurred. signOut() does replace the screen, and it
      // reaches the same nav bridge that is a no-op until app.ts installs it, so the control states its own
      // terminal outcome rather than trusting the departure to take it away.
      btn.textContent = "Everyone was signed out";
      signOut();
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: the rotation did not happen, so the lever has to be pressable again.
        btn.disabled = false;
        return goSignedOut();
      }
      // The engine's reason leads (it may be the Owner gate, or something else entirely on the worst
      // incident there is to reconstruct: a break-glass session-key rotation that did not apply). Never
      // replace it with the Owner-gate assertion; sessions may still be live and the operator must know.
      const kind = classifyError(err);
      if (kind.kind === "forbidden") toast({ message: refusedMessage(err, gateReason("owner")), tone: "warn" });
      else toast({ message: `Could not sign everyone out. ${refusalText(err)} Sessions were NOT rotated and may still be live.`, tone: "warn" });
      btn.disabled = false;
    }
  });
  allWrap.appendChild(h("div", btn));
  return allWrap;
}

// abbreviateId shortens a long opaque id (a base64url credential id) for display, keeping the head and
// tail so two keys are still distinguishable, with the full value in the title attribute.
function abbreviateId(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

// COSE signature algorithm ids (negative integers on the wire) from the IANA COSE Algorithms
// Registry / RFC 8152. Named so a transposed digit (for example ES384 vs ES512) is caught at the
// declaration rather than mislabelling an authenticator silently. These are public identifiers,
// never a secret.
const COSE_ALG_ES256 = -7;
const COSE_ALG_ED25519 = -8;
const COSE_ALG_ES384 = -35;
const COSE_ALG_ES512 = -36;
const COSE_ALG_RS256 = -257;

// coseAlgLabel maps a COSE signature algorithm id to a coarse, honest label. Unknown ids show the raw
// number rather than guessing, so a newer authenticator's alg is never mislabelled. Exported for the
// focused unit test (the known-value and unknown-default round-trip).
export function coseAlgLabel(alg: number): string {
  switch (alg) {
    case COSE_ALG_ES256: return "ES256";
    case COSE_ALG_ED25519: return "Ed25519";
    case COSE_ALG_ES384: return "ES384";
    case COSE_ALG_ES512: return "ES512";
    case COSE_ALG_RS256: return "RS256";
    default: return `COSE alg ${alg}`;
  }
}
