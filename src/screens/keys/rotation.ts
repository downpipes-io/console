// The Rotate break-glass tab of the Keys and break-glass screen: generate a new break-glass key
// pair entirely in the browser using the same keygen path as the initial ceremony, download the new
// identity.key locally, and apply ONLY the new public key to the engine via a one-shot token (no terminal).
// The keep-old-key warning is rendered prominently and precisely: archives sealed before the rotation are
// encrypted to the OLD break-glass public, the engine cannot re-encrypt them, so the operator must retain the
// old identity.key to recover old runs. Moved verbatim from the keys coordinator for size; it imports the
// shared leaf (./shared.ts) only, so it never imports another tab module (which would form a cycle).
//
// NO-CUSTODY invariants (Appendix A): the new break-glass private is generated entirely in
// the browser; nothing is POSTed, logged, stored, or transmitted; there is NO field, command, or upload path
// for the new or old break-glass private. House style: Australian English, no em dashes, precise claims.

import type { EngineClient } from "../../api.ts";
import { engineAnswered, errorDetail } from "../../components/error-view.ts";
import { confirmModal } from "../../components/modal.ts";
import { toast } from "../../components/toast.ts";
import { type CeremonyResult, identityFile, recipientFile, runKeyCeremony } from "../../keygen.ts";
import { reportKeygenFault } from "../../lib/client-diag/capability-faults.ts";
import { h } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { canDo, collapsedSection, gateReason, refuseWithReason } from "../common.ts";
import { commandWithValue, downloadText, renderTokenApply } from "./shared.ts";
import { renderKeyVintages } from "./vintages.ts";

// renderRotationSection renders the break-glass key rotation flow.
//
// The KEEP-OLD-KEY warning is rendered prominently and precisely: archives sealed
// before the rotation are encrypted to the OLD break-glass public. The engine cannot
// re-encrypt them. The operator must retain the old identity.key to recover old runs.
export function renderRotationSection(engine: EngineClient): HTMLElement {
  // Disclosure body (the heading lives in the summary, danger-toned); the inner
  // keep-old-key warning below keeps its loud tint, that one IS action-critical.
  const card = h("div", { class: "measure" });

  card.appendChild(
    h(
      "p",
      { style: "color:var(--text);margin-top:var(--space-3)" },
      "Generate a new break-glass key pair entirely in your browser. The new private key is offered as a local download and is never sent anywhere. You then apply only the new public key to your engine here, with a one-shot token. No terminal.",
    ),
  );

  // The critical archive-continuity warning: one bold sentence, warn-tinted because it
  // IS action-critical, but role="note" (static mount-time content is not an alert) and
  // never shouting (no all-caps, no IMPORTANT:).
  const keepOldWarn = h("div", {
    class: "card card--warn",
    role: "note",
    style: "margin-top:var(--space-4);border-color:var(--warn);background:var(--warn-bg)",
  });
  keepOldWarn.appendChild(
    h(
      "p",
      { style: "font-weight:var(--weight-semibold)" },
      "Archives sealed before this rotation can only be opened by the old identity.key. Keep it.",
    ),
  );
  card.appendChild(keepOldWarn);

  // The warning above says an old identity.key is still needed; this panel says WHICH keys and HOW MANY
  // runs, read keylessly from the signed manifests (GET /admin/keys/vintages).
  // It sits before the rotate control deliberately: the operator should see what the current rotation state
  // already costs them before they add another vintage to it.
  card.appendChild(renderKeyVintages(engine));

  const ownerGate = canDo("owner");
  const rotateBtn = h(
    "button",
    { "data-busy-label": "Generating in this browser", "data-dp": "keys.button.rotate",
      class: "btn btn--primary",
      type: "button",
      style: "margin-top:var(--space-4)",
    },
    "Generate new break-glass key pair",
  ) as HTMLButtonElement;
  const rotateOut = h("div");

  if (ownerGate) {
    rotateBtn.addEventListener("click", () => void handleRotateClick(engine, rotateBtn, rotateOut));
  } else {
    refuseWithReason(rotateBtn, gateReason("owner"));
  }

  card.appendChild(rotateBtn);
  // The gate reason rendered VISIBLY (a title attribute is hover-only and unreachable by
  // keyboard or touch); the title stays as a secondary cue.
  if (!ownerGate) card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, gateReason("owner")));
  card.appendChild(rotateOut);
  return card;
}

// handleRotateClick runs the browser-only rotation: generate a fresh break-glass pair, offer the new
// identity/recipient files as downloads (the only output path; nothing is sent to a server), then mount
// the apply-to-engine wiring. On failure nothing has left the browser.
async function handleRotateClick(engine: EngineClient, rotateBtn: HTMLButtonElement, rotateOut: HTMLElement): Promise<void> {
  rotateBtn.disabled = true;
  rotateBtn.textContent = "Generating in this browser";
  rotateOut.replaceChildren(
    h("p", { class: "field__hint" }, "Generating a new hybrid key pair in this browser."),
  );
  try {
    // runKeyCeremony is the same browser-only path as the initial ceremony: it calls
    // makeRecipient() (X25519 + ML-KEM-1024 seed generation), no network, no storage.
    // We set operational:false because a rotation replaces only the break-glass key;
    // the operational key is a separate, independent decision.
    const fresh = await runKeyCeremony({ operational: false });

    // Download the new break-glass identity file immediately. This is the only output
    // path: browser Blob -> a[download]. Nothing is sent to any server.
    //
    // THE ANSWER IS KEPT. downloadText returns whether the browser accepted the delivery, and a refused
    // identity.key during a rotation is the one outcome that can lock the customer out of their own future
    // archives: apply the new public key after the private never arrived, and the engine wraps every new
    // archive to a key nobody holds. So the private half's verdict gates the apply below, and the public
    // half's does not (recipient.pub is a convenience copy; the value the apply sends comes from memory).
    const identityDelivered = downloadText("identity.key", identityFile(fresh.breakGlass), "text/plain", "break-glass-rotation");
    downloadText("recipient.pub", recipientFile(fresh.breakGlass), "text/plain", "break-glass-rotation");

    rotateOut.replaceChildren(renderRotationWiring(engine, fresh, identityDelivered));
    rotateBtn.disabled = false;
    rotateBtn.textContent = "Generate another key pair";
    // Only claim the save happened when it did. The refusal already raised its own warn toast from
    // downloadText, and stacking "Save the new identity.key offline" on top of "your browser did not save
    // identity.key" is how a customer reads past the one line that matters.
    if (identityDelivered) {
      toast({ message: "New break-glass key pair generated. Save the new identity.key offline. Keep the old one for existing archives." });
    }
  } catch (err) {
    // A rotation that cannot generate keys is recorded, on its own surface. The stakes differ from the
    // first ceremony (the existing break-glass key still works, so nothing is lost yet), and that difference is
    // exactly what a support engineer needs and what a keys-screen route id cannot say. The message below is
    // for the operator and stays out of the pack: the reporter takes no error.
    reportKeygenFault("break-glass-rotation");
    rotateBtn.disabled = false;
    rotateBtn.textContent = "Generate new break-glass key pair";
    rotateOut.replaceChildren(
      h("p", { class: "field__error" }, `Key generation failed in the browser (${err instanceof Error ? err.message : String(err)}). Nothing was sent anywhere.`),
    );
  }
}

// renderRotationWiring builds the download-then-apply region: the download control for the new private
// half, the fingerprint cue, the one-shot token apply (the engine writes only BREAK_GLASS_PUBLIC), the
// post-apply presence confirmation, and the deeply-collapsed wrangler alternative for an operator who
// prefers IaC. The apply half is mounted only once the new identity.key has actually reached the disk.
//
// WHY THE ORDER IS ENFORCED AND NOT MERELY SUGGESTED. This screen's whole purpose is to keep a customer
// able to open their own archives. Applying the new public key makes the engine wrap every subsequent
// archive to it, and if the matching private never left the browser, those archives have no holder: the
// old identity.key opens only what was sealed before the rotation, and the new private is gone the moment
// the tab is closed. That is not a copy defect, it is the exact lockout a break-glass mechanism exists to
// prevent, so the apply is unreachable rather than merely discouraged.
//
// WHAT A RELOAD DOES, because a remembered flag that outlives its key would be a trap of its own. It
// cannot happen here: `identityDelivered` lives in this closure beside `fresh`, which is the only copy of
// the new private half anywhere. rotation.ts never writes to the ceremony store and renderRotationSection
// builds an empty output region on every render, so a reload, a tab change or a navigation away drops the
// key material and the delivered flag together. The customer lands back on "Generate new break-glass key
// pair" with nothing applied, and the next pair's apply is blocked again until ITS private is saved. There
// is no reachable state in which the apply is open over a key the browser never delivered.
// Exported for the validator, which drives this region through the real deliverFile so that both
// directions of the gate are proven on the production path rather than on a re-implementation.
export function renderRotationWiring(engine: EngineClient, fresh: CeremonyResult, identityDelivered: boolean): HTMLElement {
  const wiringWrap = h("div", { style: "margin-top:var(--space-4)" });
  wiringWrap.appendChild(h("h3", { class: "drawer-section__title" }, "Save the new identity.key, then apply the public half"));
  wiringWrap.appendChild(
    h("p", { class: "field__hint measure" }, "The new private key is offered as a download and is never sent anywhere. Once it is saved you paste a one-shot Cloudflare token; your engine writes the new break-glass public to its own secret, then you revoke the token. From then on the engine wraps new archives to the new key."),
  );

  wiringWrap.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-3)" }, "New break-glass fingerprint (public; safe to record in your runbook):"),
  );
  const fpEl = h("code", { class: "mono", style: "display:block;word-break:break-all;padding:var(--space-2) 0" });
  fpEl.textContent = fresh.breakGlass.fingerprint;
  wiringWrap.appendChild(fpEl);

  const presence = h("p", { class: "field__hint", role: "status", "aria-live": "polite", style: "margin-top:var(--space-2)" });
  const confirmPresence = async (): Promise<void> => {
    presence.textContent = "Confirming the engine reports the new key.";
    try {
      const s = await engine.status();
      presence.textContent = s.breakGlassConfigured
        ? "The engine reports the break-glass public key present. The old identity.key still opens archives sealed before this rotation."
        : "Not reported present yet; the engine can take a moment, then re-open this tab to confirm.";
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: mid-rotation is the worst place to strand a status line.
        presence.textContent = "Your session ended before the confirmation finished. Sign in again and re-open this tab to confirm.";
        goSignedOut();
        return;
      }
      // AN ANSWER IS NOT AN UNREACHABLE ENGINE, and mid-rotation is the worst place to say it is: an
      // operator part-way through a key rotation, told to go and check the engine is reachable, is being
      // sent away from a 429 or a dismissed step-up prompt that no amount of network checking will fix.
      presence.textContent = engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to confirm presence.";
    }
  };
  // A clear-from-memory affordance, mirroring the initial ceremony (posture.ts
  // memoryClearButton). On confirm it replaces this whole region, dropping the DOM
  // nodes that close over the fresh rotation result so the in-memory new private key
  // material becomes eligible for collection. JS cannot guarantee zeroing; this matches
  // the higher bar the initial ceremony already sets.
  const clearWrap = h("div", { style: "margin-top:var(--space-4)" });
  const clearBtn = h(
    "button",
    { "data-dp": "keys.button.clear#2", class: "btn btn--secondary btn--sm", type: "button", hidden: true },
    "I have saved the new identity.key offline; clear it from memory",
  ) as HTMLButtonElement;
  clearBtn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Clear rotation key from memory",
      body: "Confirm you have saved the new identity.key (the rotated break-glass private) to offline storage. This drops the in-memory key material from this rotation in this browser tab. The downloaded files remain on your disk.",
      confirmLabel: "Clear from memory",
    });
    if (!ok) return;
    wiringWrap.replaceChildren(
      h("p", { class: "field__hint" }, "The rotation key material has been dropped from memory in this tab. Re-open this tab to rotate again."),
    );
    toast({ message: "In-memory rotation key material cleared." });
  });
  clearWrap.appendChild(clearBtn);

  // THE DOWNLOAD CONTROL THE REFUSAL COPY REFERS TO. downloadText's warn toast ends "then use the download
  // control again", and until now this region had none: the one instruction given to a customer whose
  // browser refused their new private key named a control that did not exist on the screen they were
  // reading. It exists now, it is the control the toast means, and it is the only way past the block below.
  const applyHost = h("div", { style: "margin-top:var(--space-4)" });
  const dlWrap = h("div", { class: "stack-sm", style: "margin-top:var(--space-4)" });
  const dlStatus = h("p", { class: "field__hint", role: "status", "aria-live": "polite" });
  const downloadIdentityBtn = h(
    "button",
    { "data-dp": "keys.button.download-identity", class: "btn btn--secondary", type: "button" },
    "Download the new identity.key",
  ) as HTMLButtonElement;
  const downloadRecipientBtn = h(
    "button",
    { "data-dp": "keys.button.download-recipient", class: "btn btn--secondary btn--sm", type: "button" },
    "Download recipient.pub",
  ) as HTMLButtonElement;

  // mountApply swaps the blocked note for the real apply region, once and only once. Building it lazily is
  // what makes the block structural rather than cosmetic: before the private key is delivered there is no
  // token field, no apply button and no wrangler command in the DOM at all, so no amount of clicking,
  // tabbing or re-enabling a disabled attribute reaches an apply.
  let applyMounted = false;
  const mountApply = (): void => {
    if (applyMounted) return;
    applyMounted = true;
    const applyRegion = h("div", { class: "stack-sm" });
    applyRegion.appendChild(
      renderTokenApply({
        applyLabel: "Apply to your engine",
      tokenPurpose: "rotate the break-glass key",
        busyLabel: "Applying",
        doneLabel: "Applied",
        apply: (token) => engine.rotateBreakGlass(token, fresh.breakGlass.recipientPublicB64).then(() => undefined),
        onApplied: () => { clearBtn.hidden = false; void confirmPresence(); },
      }),
    );
    applyRegion.appendChild(presence);
    applyRegion.appendChild(clearWrap);
    // The wrangler path stays available for an operator who prefers IaC, but deeply collapsed: it is never
    // the primary apply. It sits INSIDE the gated region because it is an apply too, and a customer whose
    // private key never arrived is no safer for having installed the public half by hand.
    applyRegion.appendChild(
      collapsedSection(
        "Advanced: apply with Wrangler instead",
        h("div", { class: "stack-sm" },
          h("p", { class: "field__hint", style: "margin:0" }, "Run this in your account; wrangler uses your own Cloudflare login, so it needs no token."),
          commandWithValue("npx wrangler secret put BREAK_GLASS_PUBLIC", fresh.breakGlass.recipientPublicB64),
        ),
      ),
    );
    applyHost.replaceChildren(applyRegion);
  };

  // blockApply states what is held and why, and names the one thing that lifts it. It is the customer's
  // whole view of the apply until the private half lands, so it says the consequence rather than a bare
  // refusal: a held apply that does not explain itself is read as the screen being broken.
  const blockApply = (): void => {
    applyHost.replaceChildren(
      h("div", { class: "card card--warn", role: "note", style: "border-color:var(--warn);background:var(--warn-bg)" },
        h("p", { style: "font-weight:var(--weight-semibold)" }, "Applying the new public key is held until the new identity.key is saved."),
        h("p", { class: "measure", style: "margin-top:var(--space-2)" }, "Your browser did not save it. If the new public key went to your engine now, every archive sealed from then on would be locked to a private key you do not hold, and it is only in this tab until you close it."),
        h("p", { class: "measure", style: "margin-top:var(--space-2)" }, "Check your browser's download settings and any blocked-download prompt, then use the download control above. Nothing has been applied and your existing break-glass key still works."),
      ),
    );
  };

  const recordDelivery = (delivered: boolean): void => {
    if (delivered) {
      dlStatus.textContent = "Saved. Move it to offline storage and keep the old identity.key for archives sealed before this rotation.";
      mountApply();
      return;
    }
    // The refusal path does NOT re-block an apply that is already mounted: one successful delivery is the
    // condition, and a later refused re-download does not un-save the file that reached the disk.
    dlStatus.textContent = "Your browser did not save identity.key, so the apply below is still held.";
    if (!applyMounted) blockApply();
  };

  downloadIdentityBtn.addEventListener("click", () => {
    recordDelivery(downloadText("identity.key", identityFile(fresh.breakGlass), "text/plain", "break-glass-rotation"));
  });
  downloadRecipientBtn.addEventListener("click", () => {
    // The public half gates nothing, so its verdict is not recorded against the apply. downloadText raises
    // its own warn toast on a refusal, and the value is applied from memory rather than from this file.
    downloadText("recipient.pub", recipientFile(fresh.breakGlass), "text/plain", "break-glass-rotation");
  });

  dlWrap.appendChild(h("p", { class: "field__hint measure", style: "margin:0" }, "identity.key is the private half of the new break-glass pair. It is the only thing that will open archives sealed after this rotation, and it exists nowhere but this browser tab until you save it."));
  dlWrap.appendChild(h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, downloadIdentityBtn, downloadRecipientBtn));
  dlWrap.appendChild(dlStatus);
  wiringWrap.appendChild(dlWrap);
  wiringWrap.appendChild(applyHost);

  // The verdict from the automatic download at generation time decides which half is on screen first, so a
  // customer whose browser accepted the file is never made to click a second time, and one whose browser
  // refused it never sees an apply.
  recordDelivery(identityDelivered);

  return wiringWrap;
}
