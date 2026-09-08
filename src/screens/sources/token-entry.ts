// The discovery-token paste forms for the Sources screen: the connect-first card (the
// very first form of a fresh deployment) and the shared token-entry control it and the
// account tier reuse. Moved here verbatim so the connect-first state, the account tier
// (enable / replace) and any future caller share one form without importing a sibling
// section. The value is sent once over the authenticated same-origin channel and never
// persisted client-side. Australian English, no em dashes, precise claims.

import type { EngineClient } from "../../api.ts";
import { isOwnerActionQueuedResult } from "../../api.ts";
import { SESSION_ENDED_ACTION } from "../../components/error-view.ts";
import { requireChange } from "../../components/require-change.ts";
import { toast } from "../../components/toast.ts";
import { recordDiscoveryConnect } from "../../lib/client-diag/ring.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { gateReason, refuseWithReason } from "../common.ts";
import { errMsg } from "./shared.ts";
import { tokenHelp } from "./token-help.ts";

// tokenVerifiedToast is the PURE outcome copy for a stored discovery token, keyed on how many accounts the
// engine actually saw with it. A token the engine stored but which sees ZERO accounts is the most common
// onboarding ticket there is ("it said verified, but nothing shows"), and the old copy reported it as a
// plain success ("Token verified: 0 accounts visible") in the same reassuring tone as a working one. It is
// not a success: the token is valid but its scopes admit nothing, so nothing downstream (the source
// catalogue, the destination bucket list) can populate. It is now a WARN that names the cause, so the
// operator fixes the scopes instead of raising a ticket about an empty screen. Exported for the validator.
export function tokenVerifiedToast(accountsSeen: number): { message: string; tone?: "warn" } {
  if (accountsSeen === 0) {
    return {
      message: "The token was accepted and stored, but it can see NO accounts. Its scopes admit none, so no sources or buckets will be listed. Re-issue the token with Account read access, then verify again.",
      tone: "warn",
    };
  }
  return { message: `Token verified: ${accountsSeen} account${accountsSeen === 1 ? "" : "s"} visible.` };
}

// connectCard is the very first form of a fresh deployment: paste the read-only
// token; everything else on this screen (and the destination's bucket list) reads
// through it.
export function connectCard(engine: EngineClient, ownerGate: boolean, refresh: () => void): HTMLElement {
  return h(
    "section",
    // dataset.tourId: the inert training-walk anchor (the tour's data-tour-id idiom); the walk's connect
    // chapter pins its spotlight on this card. No behaviour on the genuine console.
    { class: "card", style: "max-width:620px", dataset: { tourId: "sources-token-entry" } },
    h("h3", { class: "section-title" }, "Connect your Cloudflare account"),
    h(
      "p",
      { class: "field__hint" },
      "Paste a READ-ONLY API token to browse everything you own; verified live, never shown again.",
    ),
    tokenEntry(engine, ownerGate, "Verify and save", refresh),
  );
}

// tokenEntry is the shared token paste form (enable + replace): the value is sent
// once over the authenticated same-origin channel and never persisted client-side.
export function tokenEntry(engine: EngineClient, ownerGate: boolean, label: string, refresh: () => void): HTMLElement {
  const input = h("input", { "data-dp": "sources.password.token-entry",
    class: "input",
    type: "password",
    autocomplete: "off",
    "aria-label": "Read-only Cloudflare API token",
    placeholder: ownerGate ? "paste the read-only API token" : "an Owner pastes the token here",
    ...(ownerGate ? {} : { disabled: true }),
  }) as HTMLInputElement;
  const saveBtn = ownerGate
    ? (h("button", { "data-busy-label": "Verifying", "data-dp": "sources.button.save#2", class: "btn btn--secondary btn--sm", type: "button" }, label) as HTMLButtonElement)
    : (h("button", { "data-dp": "sources.button.save#3", class: "btn btn--secondary btn--sm", type: "button" }, label) as HTMLButtonElement);
  // The refusal is announced and readable rather than removed from the tab order. The input beside it
  // stays `disabled` deliberately: a text field is not a control whose refusal reason is discoverable
  // by focusing it, and its placeholder already reads "an Owner pastes the token here".
  if (!ownerGate) refuseWithReason(saveBtn, gateReason("owner"));
  const err = h("p", { class: "field__error", role: "alert", hidden: true });
  if (ownerGate) {
    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (value === "") {
        err.textContent = "Paste the token first.";
        err.hidden = false;
        return;
      }
      err.hidden = true;
      // Change management (owner opt-in): setting the account-browsing token hands the engine an account-read
      // credential, a change-controlled action. Collect a change reference when the policy requires one.
      const cr = await requireChange(engine, "Set the account-browsing token", "discovery-token-set");
      if (!cr.proceed) return;
      saveBtn.disabled = true;
      saveBtn.textContent = "Verifying";
      void engine
        .setDiscoveryToken(value, cr.change ?? undefined)
        .then((res) => {
          // Dual control armed: the engine queued the token set for a second owner instead of storing it.
          // Say so honestly (NOT "token verified"), clear the field, and re-enable the button.
          if (isOwnerActionQueuedResult(res)) {
            input.value = "";
            surfaceQueuedOwnerAction("Setting the account-browsing token");
            saveBtn.disabled = false;
            saveBtn.textContent = label;
            return;
          }
          const st = res.value;
          input.value = "";
          // THE "IT SAID VERIFIED AND NOTHING SHOWS" CASE. The engine took the token, and the number of
          // accounts it could then SEE is the fact that decides whether this operator is about to have a good
          // day. Zero accounts on an accepted token is a token whose account-read scope is not what the
          // customer thinks it is, and it is the single most common onboarding report; today it produces a
          // toast that says "verified" and then an empty screen, and leaves nothing behind at all.
          //
          // The COUNT is not recorded, only whether it was zero: an account count is a coarse fact about the
          // customer's estate, and the discriminator the ticket needs is the zero, not the number.
          recordDiscoveryConnect((st.accountsSeen?.length ?? 0) > 0 ? "verified-accounts-seen" : "verified-zero-accounts");
          toast(tokenVerifiedToast(st.accountsSeen?.length ?? 0));
          refresh();
        })
        .catch((e) => {
          if (isUnauthorised(e)) {
            // PAINT FIRST, THEN LEAVE: the token was not stored, so Save comes back off "Verifying". This
            // sits ABOVE recordDiscoveryConnect because a lapsed session is not the engine refusing a
            // token, and filing it as one would put a refusal row against a healthy token.
            err.textContent = SESSION_ENDED_ACTION;
            err.hidden = false;
            saveBtn.disabled = false;
            saveBtn.textContent = label;
            return goSignedOut();
          }
          // "Verify and save always fails": the engine REFUSED the token set. The refusal prose is
          // rendered at the field and is never recorded: it is Cloudflare API text the console does not own,
          // and a classifier that guessed a closed fail class out of it would quietly mislabel the day the
          // engine reworded itself. The FACT of the refusal rides; its class belongs to the engine's own
          // discovery state, which knows it rather than inferring it.
          recordDiscoveryConnect("refused");
          err.textContent = errMsg(e);
          err.hidden = false;
          saveBtn.disabled = false;
          saveBtn.textContent = label;
        });
    });
  }
  return h(
    "div",
    { class: "stack-sm" },
    h("div", { style: "display:flex;gap:var(--space-2);align-items:center" }, input, saveBtn),
    ownerGate
      ? h(
          "p",
          { class: "field__hint", style: "margin:0" },
          h("button", { "data-dp": "sources.button.token-help", class: "linklike", type: "button", on: { click: tokenHelp } }, "How do I create this token?"),
          " Takes about a minute in the dashboard.",
        )
      : h("p", { class: "field__hint", style: "margin:0" }, `${gateReason("owner")} Connecting the account is an Owner step.`),
    err,
  );
}
