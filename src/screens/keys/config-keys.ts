// The Keys screen's targeted "add configuration keys" card, for an engine that holds a signer but lacks the
// configuration recovery key (CONFIG_RECIPIENT_PRIVATE), the configuration wrap key (CONFIG_WRAP_KEY), or
// both. Before the in-console ceremony made these keys, only the terminal deploy installed them, so an engine
// the console keyed had neither: its sealed configuration export was sealed to the break-glass key only,
// auto-heal refused, and the credentials this console stores sat on the Durable Object plaintext floor.
//
// The card generates the keys in THIS browser (keygen.ts runConfigKeysCeremony) and installs only the ones
// the engine lacks, over POST /admin/keys/add-config-recovery (engine/src/admin/router-keys.ts). The engine
// refuses to replace a configuration key it already holds, and it never reads or writes the signer, the
// break-glass public or the operational pair. Neither key is ever offered as a download.
//
// It imports the shared leaf (./shared.ts) only, like the other Keys tab modules.

import type { ConfigRewrapReport, EngineClient, StatusReport } from "../../api.ts";
import { engineAnswered, errorDetail } from "../../components/error-view.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { type ConfigKeys, runConfigKeysCeremony } from "../../keygen.ts";
import { reportKeygenFault } from "../../lib/client-diag/capability-faults.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { ICON_REFRESH } from "../../lib/icons.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { canDo, gateReason, refuseWithReason } from "../common.ts";
import { legendCol, renderTokenApply } from "./shared.ts";

// needsConfigKeys reports whether the engine holds a signer but lacks a configuration key. A signer-less
// engine gets both from its first install, so the card is only for an engine that is already keyed. An
// engine that does not report the field at all (one deployed before it existed) is not offered the card: the
// console cannot tell what it holds, and that engine has no add route to call either.
export function needsConfigKeys(s: StatusReport): boolean {
  const held = s.configKeysConfigured as StatusReport["configKeysConfigured"] | undefined;
  if (held === undefined) return false;
  return s.signerConfigured && (!held.recipient || !held.wrapKey);
}

// RecipientHalvesState tells apart the four states of the configuration recovery pair (engine ef0d5398
// HeldConfigRecipient). recipientHalves is honestly absent on an engine older than this field: the console
// then falls back to the coarse `recipient` boolean, which cannot distinguish a partial pair, so a lone
// private or a lone public both read as "none" until the engine reports the newer field.
type RecipientHalvesState = "full" | "none" | "lone-private" | "lone-public";
function recipientHalvesState(s: StatusReport): RecipientHalvesState {
  const halves = s.configKeysConfigured.recipientHalves;
  if (halves === undefined) return s.configKeysConfigured.recipient ? "full" : "none";
  if (halves.public && halves.private) return "full";
  if (halves.private) return "lone-private";
  if (halves.public) return "lone-public";
  return "none";
}

// renderAddConfigKeysEntry is the entry card. It states, in place, what each missing key does and what the
// add does not change, then generates the keys on request. The facts shown depend on which keys are missing.
// A lone public (recipientHalvesState "lone-public") is a special case: the engine refuses to complete it
// (it cannot make the private from the public, engine attach.ts lonePublicFault), so this card names the
// Cloudflare dashboard step instead of offering an add that would only be refused. The card sits in a host
// element, and the install step replaces the host's children, so the swap needs no reference to the card's
// parent.
export function renderAddConfigKeysEntry(engine: EngineClient, s: StatusReport): HTMLElement {
  const recipientState = recipientHalvesState(s);
  const lonePublic = recipientState === "lone-public";
  // missing.recipient drives what this card SAYS about the recovery key; sendRecipient drives what an add
  // actually SENDS. A lone public is missing (the engine holds no working recovery key) but is never sent:
  // the engine refuses it, and the request's generated pair would be thrown away in favour of a dashboard fix.
  const missing = { recipient: recipientState !== "full", wrapKey: !s.configKeysConfigured.wrapKey };
  const sendRecipient = recipientState === "none" || recipientState === "lone-private";
  const canAct = sendRecipient || missing.wrapKey;
  const host = h("div");
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  host.appendChild(card);
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Add configuration keys"),
      badge("warn", "Not installed"),
    ),
  );
  card.appendChild(
    h("p", { style: "color:var(--text);margin-top:var(--space-3)" },
      "Your engine was keyed without its configuration keys. This adds the missing ones. Your signer, your break-glass key and any operational key are not touched.",
    ),
  );

  const facts = h("ul", { class: "stack-sm", style: "margin-top:var(--space-3);padding-left:1.2em" });
  if (lonePublic) {
    facts.appendChild(h("li", { class: "field__hint" }, "Your engine holds the configuration recovery public without its private. It cannot make the private from the public, and this add does not replace a bound key. In the Cloudflare dashboard, delete the CONFIG_RECIPIENT_PUBLIC secret from this engine's Worker, then add the configuration keys again. Exports already sealed to that public still open with your break-glass identity.key."));
  } else if (missing.recipient) {
    facts.appendChild(h("li", { class: "field__hint" }, "The configuration recovery key lets your engine rebuild its own settings from its sealed configuration export after a storage wipe. It cannot read an archive. Exports sealed before you add it still open with your break-glass identity.key only."));
  }
  if (missing.wrapKey) {
    facts.appendChild(h("li", { class: "field__hint" }, "The configuration wrap key encrypts the credentials this console stores: destinations, integrations and the read-only Cloudflare discovery token. Adding it also encrypts the credentials already saved. The Security centre counts any destination credential that stays unencrypted."));
  }
  if (canAct) facts.appendChild(h("li", { class: "field__hint" }, "Nothing here is a file to save. The keys install straight to your engine. Losing the wrap key costs a re-entered credential, never an archive."));
  card.appendChild(facts);

  if (canAct) {
    const ownerGate = canDo("owner");
    const generateConfigKeysBtn = h(
      "button",
      { "data-dp": "keys.button.generate-config-keys", class: "btn btn--primary", type: "button" },
      "Generate configuration keys",
    ) as HTMLButtonElement;
    const progress = h("div");
    if (ownerGate) {
      generateConfigKeysBtn.addEventListener("click", () => void runConfigKeysAndRender(engine, host, generateConfigKeysBtn, progress, { recipient: sendRecipient, wrapKey: missing.wrapKey }));
    } else {
      refuseWithReason(generateConfigKeysBtn, gateReason("owner"));
    }
    card.appendChild(h("div", { style: "margin-top:var(--space-4)" }, generateConfigKeysBtn));
    if (!ownerGate) card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, gateReason("owner")));
    card.appendChild(progress);
  }
  return host;
}

// runConfigKeysAndRender generates the configuration keys in this browser and swaps the entry card for the
// install card. A failure restores the button and shows the reason in place, as the other key ceremonies do.
async function runConfigKeysAndRender(
  engine: EngineClient,
  host: HTMLElement,
  generateBtn: HTMLButtonElement,
  progress: HTMLElement,
  missing: { recipient: boolean; wrapKey: boolean },
): Promise<void> {
  generateBtn.dataset.busy = "true";
  generateBtn.textContent = "Generating in this browser";
  generateBtn.disabled = true;
  progress.replaceChildren(h("p", { class: "field__hint" }, "Generating the configuration keys in this browser."));
  try {
    const keys = await runConfigKeysCeremony();
    host.replaceChildren(renderAddConfigKeysWiring(engine, keys, missing));
    toast({ message: "Configuration keys generated in this browser." });
  } catch (err) {
    // A browser that cannot generate keys is reported on the key-ceremony surface, with no error text.
    reportKeygenFault("key-ceremony");
    generateBtn.dataset.busy = "false";
    generateBtn.textContent = "Generate configuration keys";
    generateBtn.disabled = false;
    progress.replaceChildren(
      h("p", { class: "field__error" }, `Key generation failed in the browser (${err instanceof Error ? err.message : String(err)}). Nothing was sent anywhere.`),
    );
  }
}

// configPresenceCheck polls GET /admin/status for the configuration keys. Named recheckConfig (not recheck):
// the census keys a control by its own local variable name, so a shared name would renumber both controls.
function configPresenceCheck(engine: EngineClient): { recheck: HTMLButtonElement; presence: HTMLElement; doCheck: () => Promise<void> } {
  const presence = h("span", { class: "field__hint", style: "margin-left:var(--space-2)", role: "status", "aria-live": "polite" });
  const recheckConfig = h("button", { "data-dp": "keys.button.recheck-config", class: "btn btn--secondary btn--sm", type: "button", style: "margin-top:var(--space-3)" }, svgIcon(ICON_REFRESH, { size: 14 }), "Check engine for presence") as HTMLButtonElement;
  const doCheck = async (): Promise<void> => {
    presence.textContent = "Checking.";
    try {
      const s = await engine.status();
      presence.textContent = s.configKeysConfigured.recipient && s.configKeysConfigured.wrapKey
        ? "The engine reports its configuration keys present."
        : "Not yet reported present. The engine can take a moment.";
    } catch (err) {
      if (isUnauthorised(err)) {
        // PAINT FIRST, THEN LEAVE: "Checking." is only ever replaced here.
        presence.textContent = "Your session ended before the check finished. Sign in again to re-check.";
        return goSignedOut();
      }
      // Only a fetch that threw with no status at all is an unreachable engine.
      presence.textContent = engineAnswered(err) ? errorDetail(err) : "Could not reach the engine to check presence.";
    }
  };
  recheckConfig.addEventListener("click", () => void doCheck());
  return { recheck: recheckConfig, presence, doCheck };
}

// renderAddConfigKeysWiring is the install step: a legend scoped to the configuration keys, then the one-shot
// token apply. It sends ONLY the keys the engine lacked when the card rendered; the engine refuses the whole
// call if one of them has appeared since, so a key is never replaced.
function renderAddConfigKeysWiring(engine: EngineClient, keys: ConfigKeys, missing: { recipient: boolean; wrapKey: boolean }): HTMLElement {
  const card = h("div", { class: "card measure", style: "margin-top:var(--space-5)" });
  card.appendChild(
    h("div", { class: "card__header" },
      h("h2", { class: "card__title" }, "Configuration keys generated"),
      badge("ok", "Ready to install"),
    ),
  );
  const goes: string[] = [];
  if (missing.recipient) goes.push("CONFIG_RECIPIENT_PRIVATE and its public; they open only this engine's own sealed configuration export");
  if (missing.wrapKey) goes.push("CONFIG_WRAP_KEY; it encrypts the credentials this console stores");
  const legend = h("div", { class: "custody-legend" });
  legend.appendChild(legendCol("Untouched", ["your signer private", "your break-glass key", "any operational key"], "trust"));
  legend.appendChild(legendCol("Goes to your engine", goes, "info"));
  legend.appendChild(legendCol("Goes to the vendor", ["nothing"], "ok"));
  card.appendChild(legend);

  const { recheck, presence, doCheck } = configPresenceCheck(engine);
  const rewrapLine = h("p", { class: "field__hint", role: "status", hidden: true });
  // repairedLine reports the engine's OWN answer (ConfigKeysAddResult.configRecipient), never an
  // assumption: it shows only when the engine says "repaired", meaning it held a lone recovery private
  // and completed the pair from that half rather than writing the pair this call sent.
  const repairedLine = h("p", { class: "field__hint", role: "status", hidden: true });
  card.appendChild(h("h3", { class: "drawer-section__title", style: "margin-top:var(--space-5)" }, "Install the configuration keys to your engine"));
  card.appendChild(h("p", { class: "field__hint" }, "No terminal. Paste a one-shot Cloudflare token; your engine writes ONLY these keys, then you revoke the token."));
  card.appendChild(
    renderTokenApply({
      applyLabel: "Add the configuration keys to your engine",
      tokenPurpose: "add the configuration keys",
      busyLabel: "Adding",
      doneLabel: "Configuration keys added",
      apply: (token) => engine.addConfigKeys({
        token,
        ...(missing.recipient ? { configRecipientPublic: keys.configRecipient.recipientPublicB64, configRecipientPrivate: keys.configRecipient.identityB64 } : {}),
        ...(missing.wrapKey ? { configWrapKey: keys.configWrapKeyB64 } : {}),
      }).then((r) => {
        const said = missing.wrapKey ? rewrapSentence(r.rewrap) : "";
        rewrapLine.textContent = said;
        rewrapLine.hidden = said === "";
        const repaired = r.configRecipient === "repaired";
        repairedLine.textContent = repaired ? "Your engine held half its configuration recovery key. It completed the pair from that half, and did not use the pair you generated here." : "";
        repairedLine.hidden = !repaired;
      }),
      onApplied: () => { void doCheck(); },
    }),
  );
  card.appendChild(repairedLine);
  card.appendChild(rewrapLine);
  card.appendChild(h("div", { style: "margin-top:var(--space-3)" }, recheck, presence));
  return card;
}

// rewrapSentence says what the engine did with the credentials saved before the wrap key, from its own report
// (KeyInstallResult.rewrap): the hint above promises that adding the key encrypts them, and only the report can
// say it did. An answer without the report is not read as success.
export function rewrapSentence(r: ConfigRewrapReport | undefined): string {
  if (r === undefined) return "Your engine did not report encrypting the credentials saved before. Save each one again, or check the Security centre.";
  if (r.ok && r.leftPlaintext === 0) return r.wrapped === 0 ? "Your engine found no unencrypted saved credential." : `Your engine encrypted ${r.wrapped} saved ${r.wrapped === 1 ? "credential" : "credentials"}.`;
  const classes = r.failedClasses.length > 0 ? ` (${r.failedClasses.join(", ")})` : "";
  return r.leftPlaintext > 0
    ? `${r.leftPlaintext} saved ${r.leftPlaintext === 1 ? "credential is" : "credentials are"} not encrypted${classes}. Save ${r.leftPlaintext === 1 ? "it" : "each one"} again.`
    : "Your engine could not encrypt the saved credentials. Save each one again, or check the Security centre.";
}
