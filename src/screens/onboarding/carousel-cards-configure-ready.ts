// The second half of the onboarding card deck data: chapters 2 (Configure), 3 (Your team) and
// 4 (Ready), split out of carousel-cards.ts to keep each data module under the size budget
// The cards are byte-identical to their previous form; only their
// host module moved, and carousel-cards.ts re-concatenates the first part with this part so
// OB_CARDS keeps the exact same order and contents. House rules: Australian English, no em dashes,
// precise claims.

import { blockError, sessionEnded } from "../../components/error-view.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { infoTip } from "../../components/info-tip.ts";
import { statusWithLabel } from "../../components/status.ts";
import { type AccessVerdict, accessVerdictFromCaller } from "../../components/trust-chips.ts";
import { verdictSurface } from "../../components/verdict.ts";
import type { CeremonyResult } from "../../keygen.ts";
import { recordOnboardingStep } from "../../lib/client-diag/ring.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import {
  ICON_CHEVRON_RIGHT,
  ICON_INFO,
  ICON_LOCK,
  ICON_SHIELD_CHECK,
} from "../../lib/icons.ts";
import { caller, goSignedOut, whoamiAvailable } from "../../lib/nav.ts";
import { getCeremony, getEngine } from "../../lib/store.ts";
import { preflightItemPresentation } from "./preflight.ts";
import {
  type CardDef,
  cardActions,
  cardEyebrow,
  enableGatedPrimary,
  notConnectedNotice,
} from "./shared.ts";
import {
  checkItem,
  engineFaultOutcome,
  finishSetup,
  renderInstallKeys,
  renderManualFallback,
  renderReadinessPoll,
} from "./steps.ts";
import { renderInviteForm, renderRoleModel } from "./team.ts";

// onboardingSignInItem renders the readiness checklist's sign-in row from THE trust-chip verdict, and it
// is TOTAL over the verdict: every method the engine can report has its own honest row, and a method this build
// cannot interpret reads "not recognised" rather than being called the shared break-glass token. Exported so the
// validator can drive it over every state without a DOM carousel.
export function onboardingSignInItem(v: AccessVerdict): HTMLElement {
  switch (v.state) {
    case "verified":
      return checkItem("ok", "Sign-in: verified", v.email ? `Cloudflare Access enforced; verified as ${v.email}` : "Cloudflare Access enforced.");
    case "passkey-verified":
      return checkItem("ok", "Sign-in: verified", v.email ? `Passkey sign-in; verified as ${v.email}` : "Passkey sign-in.");
    case "idp-verified":
      return checkItem("ok", "Sign-in: verified", v.email
        ? `${v.protocol === "saml" ? "SAML" : "OIDC"} sign-in through your identity provider, verified by the engine; verified as ${v.email}`
        : `${v.protocol === "saml" ? "SAML" : "OIDC"} sign-in through your identity provider, verified by the engine.`);
    case "recovery-verified":
      return checkItem("warn", "Sign-in: recovery code", "This session was opened with a recovery code, the break-glass door. Return to Access, a passkey or your identity provider, and issue fresh recovery codes.");
    case "token-fallback":
      return checkItem("warn", "Sign-in: token fallback", "Token fallback in use; harden via the Access verifier or a passkey.");
    case "session-present":
      return checkItem("warn", "Sign-in: method not reported", "The session is authenticated and the engine did not report how. Update the engine to see the sign-in method here.");
    case "unverified":
      return checkItem("warn", "Sign-in: not verified", "The engine did not accept this session. Sign in again.");
    case "unknown":
      return checkItem("warn", "Sign-in: not recognised", "The engine reported a sign-in method this console build does not know. Update the console; the posture itself is not in question.");
  }
}

// ---------------------------------------------------------------------------
// Chapters 2 (Configure), 3 (Your team) and 4 (Ready)
// ---------------------------------------------------------------------------

export const OB_CARDS_CONFIGURE_READY: CardDef[] = [
  // -- Chapter 2: Configure ------------------------------------------------
  {
    id: "install", chapter: 2, gate: true, nudge: "Install your keys to continue.",
    // The trust line names only what this card ACTUALLY installs, and it must hold under BOTH postures.
    // It used to say "your signer and operational keys", which is the operational posture's install list
    // read out to every customer, including the one who had just chosen offline-key-only precisely so that
    // no operational key would exist. Naming a key the customer declined, on the card where the install
    // happens, is the worst place to be imprecise about custody.
    custody: "The keys your engine needs install to your own engine, never to us. Your break-glass private key is not one of them.",
    mount(host, nav) {
      host.appendChild(cardEyebrow("Configure"));
      host.appendChild(h("h2", { class: "cx-title" }, "Install your keys to your engine"));
      host.appendChild(h("p", { class: "cx-lede" }, "No terminal needed. You paste a one-shot Cloudflare token; your engine uses it to write its own secrets, then you revoke it. The break-glass key is never installed."));

      const engine = getEngine();
      if (!engine) {
        host.appendChild(h("div", { class: "cx-body" }, notConnectedNotice()));
        host.appendChild(cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance(), enabled: false, reason: "Connect to your engine first." } }).row);
        return;
      }

      const body = h("div", { class: "cx-body" });
      host.appendChild(body);
      const result = getCeremony() as CeremonyResult | null;
      let onKeysPresent: (() => void) | null = null;

      if (result) {
        const { el: installEl, onInstalled } = renderInstallKeys(engine, result);
        body.appendChild(installEl);
        onKeysPresent = () => onInstalled();
      } else {
        // Resumed without in-tab key material: either the engine already has its keys, or it does
        // not. A one-shot status read picks the correct state, exactly as the old configure step did.
        const ctaHost = h("div");
        ctaHost.appendChild(statusWithLabel("info", "Checking your engine for existing keys..."));
        body.appendChild(ctaHost);
        const showAlreadyConfigured = () => ctaHost.replaceChildren(verdictSurface({ tone: "trust", glyph: ICON_SHIELD_CHECK, title: "Your engine already has its keys", body: "Nothing to install here. The Engine readiness list below confirms the engine reports the signer and break-glass keys present. Generate again only if you intend to replace them." }));
        const showGenerateFirst = () => ctaHost.replaceChildren(verdictSurface({ tone: "info", glyph: ICON_INFO, title: "Generate your keys first", body: "Installing keys to the engine needs the material the in-browser step generates (it stays in this tab only). Generate them, then come back and install with one click, no terminal.", action: { label: "Go to generate your keys", onClick: () => nav.back() } }));
        onKeysPresent = showAlreadyConfigured;
        // This catch MISDIAGNOSES on the operator's behalf. A status read that fails is treated exactly
        // like a status read that said "no keys", so the wizard tells an operator whose engine ALREADY HAS its
        // keys to go back and generate them again, which is the one instruction that would replace working keys
        // on a working engine. Falling back to the safe prompt is the right rendering; doing it silently is
        // what leaves the pack with nothing to say when the customer asks why the wizard sent them backwards.
        void engine
          .status()
          .then((s) => {
            if (s.signerConfigured && s.breakGlassConfigured) showAlreadyConfigured();
            else showGenerateFirst();
          })
          .catch((err: unknown) => {
            // The row this catch used to write was a DOUBLE untruth, and it is the reason the install row could
            // not be trusted. It said `install` for a read that installs nothing (no POST, no key material, and
            // the engine's own key-ceremony recorder therefore has nothing to join against), and it said
            // `transport-error` UNCONDITIONALLY -- no status check of any kind -- so an engine that ANSWERED 500
            // or 401 was filed under the outcome whose own definition promises that no engine-side evidence of it
            // can exist. It then COALESCED, by tuple key, with the genuine install-POST row from steps.ts.
            //
            // It is its own step now, classified by the same total classifier every other site uses. A null class is
            // an aborted read (a navigation or an unmount), which is not a fault and is not recorded.
            const fault = engineFaultOutcome(err);
            if (fault !== null) recordOnboardingStep("keys-precheck", fault);
            showGenerateFirst();
          });
      }

      // The gating "Engine readiness" poll renders directly under the install affordance, ABOVE
      // the standing trust callout and the collapsed manual fallback: it is the state that
      // unlocks Continue, so it must be visible without scrolling past static prose.
      const { card, onReady } = renderReadinessPoll(engine);
      body.appendChild(card);

      body.appendChild(
        verdictSurface({ tone: "trust", glyph: ICON_LOCK, title: "The break-glass private key is never installed", body: "The engine never holds it; there is no field and no path that sends it. That is what makes recovery yours alone." }),
      );
      body.appendChild(renderManualFallback(result));

      const { row, primaryBtn } = cardActions({
        nav,
        primary: { label: "Continue", onClick: () => nav.advance(), enabled: false, reason: "Continue enables once the engine reports the keys are present." },
      });
      host.appendChild(row);
      onReady(() => { enableGatedPrimary(primaryBtn); nav.markPassed(); onKeysPresent?.(); });
    },
    // Rebuild from the live ceremony result + a fresh engine-status read when the operator returns, so a
    // "replace my keys" round-trip installs the CURRENT key material (not the first set) and the readiness
    // poll re-checks against the now-fresh engine. The prior poll's node is detached by the rebuild so it
    // stops itself; mount starts a fresh one.
    onShow(host, nav) { host.replaceChildren(); this.mount(host, nav); },
  },

  // -- Chapter 3: Your team ------------------------------------------------
  {
    id: "team", chapter: 3,
    custody: "Roles are enforced by your engine. This step is optional.",
    mount(host, nav) {
      host.appendChild(h("p", { class: "cx-eyebrow" }, "Your team, optional"));
      host.appendChild(h("h2", { class: "cx-title" }, "Invite your team"));
      host.appendChild(h("p", { class: "cx-lede", style: "margin-bottom:var(--space-4)" }, "Grant a teammate a role by email, so more than one person can run and approve things from day one. You can also skip and do this later from Access, then Roles."));

      const body = h("div", {});
      body.appendChild(renderRoleModel());
      const engine = getEngine();

      // ONE advancing action at a time: with no grant made yet the only honest label is
      // "Skip for now" (nothing was done to continue FROM); once a grant has been made the
      // action becomes the primary "Continue". Two buttons that both advanced read as a
      // choice that did not exist.
      const actionsHost = h("div");
      const showActions = (granted: boolean): void => {
        actionsHost.replaceChildren(
          granted
            ? cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance() } }).row
            : cardActions({ nav, secondary: { label: "Skip for now", onClick: () => nav.advance() } }).row,
        );
      };
      showActions(false);

      if (engine) body.appendChild(renderInviteForm(engine, () => showActions(true)));
      else body.appendChild(notConnectedNotice());
      host.appendChild(body);
      host.appendChild(actionsHost);
    },
  },

  // -- Chapter 3b: How you approve a restore -------------------------------
  // PLACED AFTER THE TEAM STEP DELIBERATELY. The choice depends on whether a second person exists, and the
  // team step is where one is invited, so asking before it would offer a setting the operator cannot yet
  // take. Skipping leaves the engine default, which is OFF: a restore apply proceeds on the acting identity.
  //
  // THIS STEP EXISTS BECAUSE THE GATE USED TO BE UNCONDITIONAL. A restore approval must come from someone
  // other than the requester, so on a one-person estate no approval could ever be granted and the apply was
  // unreachable, in a configuration the product itself calls valid.
  {
    id: "restore-approval", chapter: 3,
    custody: "Your engine enforces this. It can be changed later in Security Centre.",
    mount(host, nav) {
      host.appendChild(h("p", { class: "cx-eyebrow" }, "Restores, optional"));
      host.appendChild(h("h2", { class: "cx-title" }, "Who can approve a restore?"));
      host.appendChild(h("p", { class: "cx-lede", style: "margin-bottom:var(--space-4)" }, "A restore apply writes archived data back over live data, and it is not rolled back. You can require a second person to approve it, or run restores on your own."));

      const body = h("div", { class: "cx-body" });
      body.appendChild(
        h("ul", { class: "field__hint", style: "margin:0 0 var(--space-4);padding-left:var(--space-4);display:grid;gap:var(--space-1)" },
          h("li", "On your own: you apply a restore yourself. The dry run, the plan it binds to, the passkey re-check and the audit trail all still apply."),
          h("li", "With a second approver: an apply needs another authorised person to approve that exact plan, and it cannot be the person who asked."),
          h("li", "Requiring a second approver needs a second Owner or Approver, otherwise nobody could approve your restore."),
        ),
      );

      const engine = getEngine();
      // The estate as it stands. A sole Owner cannot arm this: the engine refuses it server-side, and saying
      // so here means the operator reads the reason instead of meeting a refusal after choosing.
      const solo = caller()?.isOnlyOwner === true;
      const outcome = h("div", { style: "margin-top:var(--space-3)" });

      const choose = async (on: boolean): Promise<void> => {
        if (!engine) { nav.advance(); return; }
        outcome.replaceChildren(h("p", { class: "field__hint" }, "Saving"));
        try {
          await engine.setRestoreApprovalPolicy(on);
          // No recordOnboardingStep here, matching the team step beside it. CLIENT_DIAG_ONBOARDING_STEPS is
          // a closed vocabulary over the KEY-CEREMONY steps, and its own header sets the rule that a member
          // may only be written where the code established the fact it asserts. A setup choice is not one of
          // those facts, and the engine already audits the policy change as config-policy-change.
          //
          // Cleared BEFORE advancing: nav.advance() leaves this card, and a card left holding "Saving"
          // shows it again if the operator steps back. Same rule as the signed-out path below.
          outcome.replaceChildren();
          nav.advance();
        } catch (err) {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE. outcome is holding the "Saving" placeholder set above, and
            // goSignedOut() is not a repaint: the nav bridge is a no-op until app.ts installs it, so
            // leaving on this path without clearing it strands the card on a busy state that nothing
            // will ever replace. The restore flow froze exactly this way.
            outcome.replaceChildren(h("p", { class: "field__hint" }, "Your session ended before this was saved. Sign in again and the choice is still yours to make here or in Security Centre."));
            return goSignedOut();
          }
          // The engine's sentence names the remedy (appoint a second Owner or Approver first); a generic
          // "could not save" would throw exactly that away.
          outcome.replaceChildren(blockError(err, () => void choose(on), { origin: location.origin }));
        }
      };

      const row = h("div", { style: "display:flex;gap:var(--space-3);flex-wrap:wrap" });
      // The data-dp values are MECHANICALLY DERIVED from these variable names, so the names are the hook
      // names (test/validate-hooks.ts refuses a hand-edited value). Named for what each choice means rather
      // than for its position in the row.
      const restoreSolo = h("button", { "data-dp": "onboarding.button.restore-solo", class: "btn btn--secondary", type: "button", on: { click: () => void choose(false) } }, "I will restore on my own");
      row.appendChild(restoreSolo);
      const restoreApprover = h("button", { "data-dp": "onboarding.button.restore-approver", class: "btn btn--primary", type: "button", on: { click: () => void choose(true) } }, "Require a second approver") as HTMLButtonElement;
      if (solo) {
        restoreApprover.disabled = true;
        restoreApprover.title = "This estate has one identity. Invite a second Owner or Approver first.";
      }
      row.appendChild(restoreApprover);
      body.appendChild(row);
      if (solo) body.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "You are the only identity in this estate, so a second approver cannot be required yet. You can turn it on in Security Centre once someone else is invited."));
      if (!engine) body.appendChild(notConnectedNotice());
      body.appendChild(outcome);
      host.appendChild(body);
      host.appendChild(cardActions({ nav, secondary: { label: "Decide later", onClick: () => nav.advance() } }).row);
    },
  },

  // -- Chapter 4: Ready ----------------------------------------------------
  {
    id: "readiness", chapter: 4,
    custody: "These are the checks your engine can verify for itself.",
    mount(host, nav) {
      host.appendChild(cardEyebrow("Ready"));
      host.appendChild(h("h2", { class: "cx-title" }, "A quick posture check"));
      host.appendChild(h("p", { class: "cx-lede", style: "margin-bottom:var(--space-4)" }, "These are the checks your engine verifies for itself. The account setup you confirmed earlier is not repeated here."));

      const engine = getEngine();
      if (!engine) {
        host.appendChild(h("div", { class: "cx-body" }, notConnectedNotice()));
        host.appendChild(cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance(), enabled: false, reason: "Connect to your engine first." } }).row);
        return;
      }

      const listCard = h("div", { class: "card measure" });
      host.appendChild(listCard);

      const advanceHost = h("div");
      host.appendChild(advanceHost);

      // Show ONLY the auto-verifiable checks: keys + sign-in, then the engine-OBSERVED preflight
      // items (status verified or failed). The manual prerequisites (Workers plan, R2, Access,
      // email) live on the first screen now, so the unproven / to-do items are not repeated here,
      // and the verbose remediation walls are folded into a pop-style tip per row. The load is a
      // named function so the failed card's Retry re-RUNS the check (it used to call nav.back(),
      // which walked away from the card instead of retrying).
      const load = (): void => {
        listCard.replaceChildren(skeletonRows(5));
        advanceHost.replaceChildren(cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance(), enabled: false, reason: "Reading your engine posture." } }).row);
        Promise.all([engine.status(), engine.preflight().catch(() => null)]).then(([s, pf]) => {
          const items: HTMLElement[] = [];
          // The two synthetic rows (keys, sign-in) read in the same "Name: verified" grammar as
          // the engine-observed preflight rows beneath them, so the list scans as one vocabulary.
          const keysIn = s.signerConfigured && s.breakGlassConfigured;
          items.push(checkItem(keysIn ? "ok" : "warn", `Keys on your engine: ${keysIn ? "verified" : "not yet"}`, keysIn ? "The signer and break-glass keys are present." : "Finish the configure step to install them."));
          const c = caller();
          if (whoamiAvailable() && c) {
            // THE THIRD ARM USED TO BE AN `else`, AND IT NAMED THE CUSTOMER'S POSTURE FALSELY. Anything that
            // was not `access` or `passkey` -- a live OIDC session, a live SAML session, a recovery-code sign-in,
            // and any method a newer engine adds -- got "Sign-in: token fallback. Token fallback in use", which is
            // the gap's ticket scenario verbatim, and it was wrong for every one of them. It read the method
            // itself instead of asking the ONE classifier, so it also recorded nothing: an unrecognised method
            // rendered the break-glass claim and left the pack with no evidence that this surface had been handed
            // a value it could not read. accessVerdictFromCaller answers honestly for all six methods and records
            // the wire-anomaly row itself.
            items.push(onboardingSignInItem(accessVerdictFromCaller(c, true)));
          } else {
            items.push(checkItem("neutral", "Sign-in: not yet confirmed", "The engine has not yet reported the verified identity."));
          }
          if (pf && Array.isArray(pf.items)) {
            for (const it of pf.items.filter((i) => i.status === "verified" || i.status === "failed")) {
              const p = preflightItemPresentation(it.status);
              items.push(
                h(
                  "div",
                  { class: "readiness-item" },
                  statusWithLabel(p.tone, `${it.name}: ${p.word}`),
                  infoTip(`Requires ${it.requires}. Observed: ${it.evidence}`, { label: `About ${it.name}` }),
                ),
              );
            }
          }
          listCard.replaceChildren(...items);
          advanceHost.replaceChildren(cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance() } }).row);
        }).catch((err) => {
          if (isUnauthorised(err)) {
            // PAINT FIRST, THEN LEAVE. Both hosts are placeholders: the list is a skeleton and Continue is
            // disabled reading "Reading your engine posture." Leaving them there strands the wizard on a
            // step with no way forward and no way back.
            listCard.replaceChildren(sessionEnded(() => load()));
            advanceHost.replaceChildren(cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance() } }).row);
            return goSignedOut();
          }
          // The readiness checks could not be READ, and Continue stays enabled anyway (deliberately, and
          // correctly: these checks gate nothing). So the wizard lets the operator finish against an engine
          // whose posture was never verified, and afterwards nothing anywhere says the verification did not
          // happen. From the engine's side an unverified finish and a verified one are the same finish.
          //
          // CLASSIFIED, not assumed. This site hard-coded `transport-error` too, which asserts the engine never
          // saw the request. An engine that answered 500 to the readiness read is a live engine with a fault, and
          // its own logs hold the other half; telling support no such evidence can exist sends them away from it.
          const finishFault = engineFaultOutcome(err);
          if (finishFault !== null) recordOnboardingStep("finish", finishFault);
          listCard.replaceChildren(blockError(err, () => load(), { origin: location.origin }));
          // Continue stays enabled on a failed READ (these checks gate nothing), with the honest
          // reason beside it rather than a silently permissive button.
          advanceHost.replaceChildren(
            cardActions({ nav, primary: { label: "Continue", onClick: () => nav.advance() } }).row,
            h("p", { class: "field__hint" }, "You can finish now; these checks re-run on the Overview."),
          );
        });
      };
      load();
    },
  },
  {
    id: "done", chapter: 4,
    heroTone: "ok",
    custody: "Setup complete. Your keys were generated here and never sent to us.",
    mount(host, nav) {
      host.appendChild(h("div", { class: "cx-hero-mark" }, svgIcon(ICON_SHIELD_CHECK, { size: 28 })));
      host.appendChild(h("p", { class: "cx-eyebrow" }, "All set"));
      host.appendChild(h("h2", { class: "cx-title" }, "You are ready to go"));
      host.appendChild(h("p", { class: "cx-lede" }, "Your console is configured. Next, point it at a destination and create your first downpipe."));
      host.appendChild(
        cardActions({ nav, primary: { label: "Open the console", icon: ICON_CHEVRON_RIGHT, onClick: () => void finishSetup() } }).row,
      );
    },
  },
];
