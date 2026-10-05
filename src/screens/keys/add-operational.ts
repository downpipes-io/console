// Add an operational key only (state-aware; break-glass-only -> operational), split out of posture.ts to
// keep that file under its length budget. renderAddOperationalEntry is the only export: everything else
// here supports it, exactly as it did inline.

import type { EngineClient } from "../../api.ts";
import { badge } from "../../components/status.ts";
import { engineAnswered, errorDetail } from "../../components/error-view.ts";
import { toast } from "../../components/toast.ts";
import { type KeyMaterial, runOperationalOnlyCeremony } from "../../keygen.ts";
import { reportKeygenFault } from "../../lib/client-diag/capability-faults.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { ICON_REFRESH } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { canDo, collapsedSection, gateReason, refuseWithReason } from "../common.ts";
import { legendCol, renderTokenApply } from "./shared.ts";

// ---- Add an operational key only (state-aware; break-glass-only -> operational) ----------------------
//
// The targeted upgrade for an estate that already has a signer and a break-glass key: it installs ONLY an
// operational pair, via POST /keys/add-operational (engine/src/admin/router-keys.ts), so it never touches
// the signer or the break-glass key. States four facts honestly, in place, at the moment they matter:
//   1. archives sealed before this stay break-glass-only recoverable, forever; new archives gain
//      operational recoverability too (the recipient set is baked into each archive at seal time).
//   2. drills, scheduled restore tests and retention pruning resume automatically, on their next run, with no
//      further action, and in-console restore stops needing the break-glass key each time. It was never off:
//      the break-glass path supplies a per-run master from the browser, so saying it "resumes" would imply a
//      capability the estate did not have.
//   3. no new identity.key is needed: the break-glass key is untouched.
//   4. no signer rotation happens, so every existing run stays verifiable and restorable through this
//      console exactly as before (contrast the full "Generate keys" ceremony, which reissues both).
export function renderAddOperationalEntry(engine: EngineClient, renderFullRekey: () => HTMLElement): HTMLElement {
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Add an operational key"),
      badge("info", "Break-glass-only today"),
    ),
  );

  card.appendChild(
    h("p", { style: "color:var(--text);margin-top:var(--space-3)" },
      "Your engine already has a signer and a break-glass key, and holds no key that can read your archives. This adds an operational key only, so your engine can prove backups restore on its own. Your signer and break-glass key are not touched.",
    ),
  );

  const facts = h("ul", { class: "stack-sm", style: "margin-top:var(--space-3);padding-left:1.2em" });
  facts.appendChild(h("li", { class: "field__hint" }, "Archives sealed before you add this key stay recoverable with your break-glass identity.key only, forever. Archives sealed afterwards gain operational recoverability too."));
  facts.appendChild(h("li", { class: "field__hint" }, "For backups sealed after you add this key, drills, scheduled restore tests and retention pruning run on their own, and restoring them from this console does not ask for your break-glass key. Nothing else to do here. Verify-at-seal and the canary were already running: they do not need this key."));
  facts.appendChild(h("li", { class: "field__hint" }, "No new identity.key is needed: your break-glass key is unchanged."));
  facts.appendChild(h("li", { class: "field__hint" }, "Your signer is unchanged, so verification of your existing runs keeps working through this console exactly as before. The full re-key rotates the signer and stops that verification. It does not change your configuration keys."));
  card.appendChild(facts);

  const ownerGate = canDo("owner");
  // Named generateOperationalBtn (not generateBtn): the census keys a control by its own local variable
  // name (VAR_SUFFIXES-stripped), not by the data-dp string, so reusing "generateBtn" here would collide
  // with renderCeremonyEntry's button of the same name in posture.ts and silently renumber both.
  const generateOperationalBtn = h(
    "button",
    { "data-dp": "keys.button.generate-operational",
      class: "btn btn--primary",
      type: "button",
    },
    "Generate operational key",
  ) as HTMLButtonElement;
  const progress = h("div");

  if (ownerGate) {
    generateOperationalBtn.addEventListener("click", () => void runAddOperationalAndRender(engine, card, generateOperationalBtn, progress));
  } else {
    refuseWithReason(generateOperationalBtn, gateReason("owner"));
  }

  card.appendChild(h("div", { style: "margin-top:var(--space-4)" }, generateOperationalBtn));
  if (!ownerGate) card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, gateReason("owner")));
  card.appendChild(progress);

  // Escape hatch: an owner who deliberately wants the full re-key (a new signer AND break-glass pair, not
  // only the operational key) can still reach it, collapsed so it is never the default for this state.
  card.appendChild(
    collapsedSection(
      "Advanced: run the full re-key ceremony instead",
      h(
        "div",
        { class: "stack-sm" },
        h(
          "p",
          { class: "field__hint", style: "margin:0" },
          "This replaces your signer and your break-glass key: a new identity.key to save, and specific older runs stop opening through this console afterwards (verify them with the offline reader and the matching old signer.pub instead). It adds an operational key only if you clear its strict custody box. Most owners adding an operational key do not need this.",
        ),
        fullRekeyInsteadButton(card, ownerGate, renderFullRekey),
      ),
    ),
  );

  return card;
}

// fullRekeyInsteadButton swaps the add-operational card for the existing, unchanged first-time ceremony
// card, for the rare owner who deliberately wants the full re-key from this state. Pulled out of
// renderAddOperationalEntry to keep that function under the length budget. posture.ts passes the ceremony
// card's render in as renderFullRekey, so this file does not import posture.ts and the two form no cycle.
function fullRekeyInsteadButton(card: HTMLElement, ownerGate: boolean, renderFullRekey: () => HTMLElement): HTMLButtonElement {
  const fullRekeyInsteadBtn = h(
    "button",
    { "data-dp": "keys.button.full-rekey-instead",
      class: "btn btn--secondary btn--sm",
      type: "button",
    },
    "Run the full re-key ceremony instead",
  ) as HTMLButtonElement;
  // The escape hatch is a DELIBERATE re-key from a break-glass-only estate (which already has a signer), and
  // its collapsed section already warned that this replaces the signer. Render the ceremony card in re-key
  // mode so it repeats the signer-continuity warning and its install carries confirmRekey.
  if (ownerGate) fullRekeyInsteadBtn.addEventListener("click", () => card.replaceWith(renderFullRekey()));
  else refuseWithReason(fullRekeyInsteadBtn, gateReason("owner"));
  return fullRekeyInsteadBtn;
}

// runAddOperationalAndRender runs the browser-only operational-key ceremony (no-custody, async post-quantum
// keygen): no download (the operational private is not a recovery credential, so unlike identity.key it is
// never offered as a file, only installed straight to the engine below), and swaps the entry card for the
// wiring card. A failure restores the button and shows the reason in place, exactly like the full ceremony.
async function runAddOperationalAndRender(
  engine: EngineClient,
  card: HTMLElement,
  generateBtn: HTMLButtonElement,
  progress: HTMLElement,
): Promise<void> {
  generateBtn.dataset.busy = "true";
  generateBtn.textContent = "Generating in this browser";
  generateBtn.disabled = true;
  progress.replaceChildren(h("p", { class: "field__hint" }, "Generating the operational key pair in this browser."));
  try {
    const operational = await runOperationalOnlyCeremony();
    const fresh = renderAddOperationalWiring(engine, operational);
    card.replaceWith(fresh);
    toast({ message: "Operational key generated in this browser." });
  } catch (err) {
    // The same honest capture the full ceremony and the rotation both use, on its OWN surface tag,
    // so a browser that cannot generate keys is visible in the pack for THIS action specifically.
    reportKeygenFault("add-operational-key");
    generateBtn.dataset.busy = "false";
    generateBtn.textContent = "Generate operational key";
    generateBtn.disabled = false;
    progress.replaceChildren(
      h("p", { class: "field__error" }, `Key generation failed in the browser (${err instanceof Error ? err.message : String(err)}). Nothing was sent anywhere.`),
    );
  }
}

// operationalPresenceCheck mirrors posture.ts's presenceCheck, but polls for the OPERATIONAL key
// specifically rather than the signer + break-glass pair, since that is the one binding this flow ever
// installs. Named recheckOperational (not recheck): the census keys a control by its own local variable
// name, so reusing "recheck" here would collide with presenceCheck's button of the same name.
function operationalPresenceCheck(engine: EngineClient): { recheck: HTMLButtonElement; presence: HTMLElement; doCheck: () => Promise<void> } {
  const presence = h("span", { class: "field__hint", style: "margin-left:var(--space-2)", role: "status", "aria-live": "polite" });
  const recheckOperational = h("button", { "data-dp": "keys.button.recheck-operational", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" }, svgIcon(ICON_REFRESH, { size: 14 }), "Check engine for presence") as HTMLButtonElement;
  const doCheck = async (): Promise<void> => {
    presence.textContent = "Checking.";
    try {
      const s = await engine.status();
      presence.textContent = s.operationalConfigured.private
        ? "The engine reports the operational key present. For backups sealed after this, drills, scheduled restore tests and retention pruning run on their own, and restoring them from this console does not ask for your break-glass key."
        : "Not yet reported present. The engine can take a moment.";
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: this line says "Checking." until something replaces it, and only
        // this handler ever does.
        presence.textContent = "Your session ended before the check finished. Sign in again to re-check.";
        return goSignedOut();
      }
      // AN ANSWER IS NOT AN UNREACHABLE ENGINE. The 401 is answered above; a 429, a 503 with no ENGINE
      // binding and a step-up the operator dismissed must not read as the reachability line below, because
      // none of them are a network problem. This read is step-up gated, so the
      // dismissed-prompt case is not hypothetical here.
      presence.textContent = engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to check presence.";
    }
  };
  recheckOperational.addEventListener("click", () => void doCheck());
  return { recheck: recheckOperational, presence, doCheck };
}

// renderAddOperationalWiring is the install step for the operational-only ceremony: a custody legend
// scoped to just the operational pair (the signer and break-glass rows read "untouched", never repeating
// the full ceremony's legend), then the one-shot-token apply to POST /keys/add-operational.
function renderAddOperationalWiring(engine: EngineClient, operational: KeyMaterial): HTMLElement {
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Operational key generated"),
      badge("ok", "Ready to install"),
    ),
  );

  const legend = h("div", { class: "custody-legend" });
  legend.appendChild(legendCol("Untouched", ["your signer private (still only in your engine)", "your break-glass key (identity.key stays the one you already have)"], "trust"));
  legend.appendChild(legendCol("Goes to your engine", ["operational.pub", "OPERATIONAL_PRIVATE, the read-back key; it can decrypt archives sealed from now on"], "info"));
  legend.appendChild(legendCol("Goes to the vendor", ["nothing"], "ok"));
  card.appendChild(legend);
  card.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
      "The operational private is not a recovery credential, so it is not offered as a download here; it installs straight to your engine below.",
    ),
  );

  const { recheck, presence, doCheck } = operationalPresenceCheck(engine);

  card.appendChild(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-5)" }, "Install the operational key to your engine"));
  card.appendChild(
    h("p", { class: "field__hint" }, "No terminal. Paste a one-shot Cloudflare token; your engine writes ONLY the operational key, then you revoke the token. Your signer and break-glass key are not sent and are not changed."),
  );

  card.appendChild(
    renderTokenApply({
      applyLabel: "Add the operational key to your engine",
      tokenPurpose: "add the operational key",
      busyLabel: "Adding",
      doneLabel: "Operational key added",
      apply: (token) => engine.addOperationalKey({
        token,
        operationalPublic: operational.recipientPublicB64,
        operationalPrivate: operational.identityB64,
      }).then(() => undefined),
      onApplied: () => { void doCheck(); },
    }),
  );
  card.appendChild(h("div", { style: "margin-top:var(--space-3)" }, recheck, presence));

  card.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-3)" },
      "For backups sealed after you add this key, drills, scheduled restore tests and retention pruning run on their own, and restoring them from this console does not ask for your break-glass key. There is nothing further to do here. Verify-at-seal and the canary were already running without this key.",
    ),
  );

  return card;
}
