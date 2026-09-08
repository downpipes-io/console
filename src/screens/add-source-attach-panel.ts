// The binding-steps scaffold for the "attach a source manually" screen (add-source.ts): steps 2
// and 3 (the identifiers group and the in-portal attach panel) parented under one bindingSteps
// element so the screen can hide them as a unit when a token source is picked. Pulled out of the
// screen so the orchestration closure stays small. This builds the DOM only and returns the element
// handles the screen wires (the click handlers, refreshCli and the attach call stay in the screen).
// The markup is byte-identical to the inlined version, so behaviour is unchanged.
//
// House: Australian English, no em dashes, precise claims.

import { h, refuseWithReason, svgIcon } from "../lib/dom.ts";
import { collapsedSection, gateReason } from "./common.ts";
import { ICON_CHECK } from "../lib/icons.ts";

// AttachPanel is the built binding-steps scaffold: the bindingSteps container plus the live element
// handles the screen needs to wire and update.
export interface AttachPanel {
  bindingSteps: HTMLElement;
  formError: HTMLElement;
  tokenInput: HTMLInputElement;
  attachLabel: HTMLElement;
  attachBtn: HTMLButtonElement;
  tokenHelpLink: HTMLButtonElement;
  attachErr: HTMLElement;
  resultHost: HTMLElement;
  cliCodeHost: HTMLElement;
}

// buildAttachPanel constructs steps 2 and 3 under one bindingSteps element. idsField is the
// identifiers group (built in add-source-fields.ts). ownerGate decides whether the token input and
// attach button are live or shown as gated. The screen appends the wired handlers afterwards.
export function buildAttachPanel(idsField: HTMLElement, ownerGate: boolean): AttachPanel {
  // bindingSteps holds steps 2 and 3, the identifiers + the in-portal attach, which apply ONLY to
  // a BINDING source (kv/r2/d1/secrets). A token source (cf-config/workers) carries no binding and is
  // configured on the downpipe, so selecting one HIDES this whole block and shows the hand-off panel
  // instead. The binding flow inside is byte-identical to before; it is merely parented here so it can
  // be hidden as a unit.
  const bindingSteps = h("div");

  bindingSteps.appendChild(h("h2", { class: "page-header__title", style: "font-size:var(--text-md);margin-top:var(--space-5)" }, "2. Enter the identifiers"));
  bindingSteps.appendChild(idsField);

  // The form-level error slot (channel one: at the form, never a toast).
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });
  bindingSteps.appendChild(formError);

  // --- Step 3: attach the binding to the engine, in the portal (no terminal) ---
  bindingSteps.appendChild(h("h2", { class: "page-header__title", style: "font-size:var(--text-md);margin-top:var(--space-5)" }, "3. Attach it to the engine"));
  bindingSteps.appendChild(
    h(
      "p",
      { class: "field__hint" },
      "The engine adds this binding to itself and re-reads its bindings to confirm none of its own changed. Paste a short-lived, scoped deploy token: it is used once for this single change, never stored, then you revoke it.",
    ),
  );

  const tokenInput = h("input", { "data-dp": "add-source-attach-panel.password.token",
    class: "input mono",
    type: "password",
    autocomplete: "off",
    "aria-label": "One-shot deploy token",
    placeholder: ownerGate ? "paste a deploy token (used once, never stored)" : "an Owner attaches sources",
    ...(ownerGate ? {} : { disabled: true }),
  }) as HTMLInputElement;
  const attachLabel = h("span", null, "Attach this source");
  const attachBtn = ownerGate
    ? (h("button", { "data-dp": "add-source-attach-panel.button.attach#1", class: "btn btn--primary", type: "button" }, svgIcon(ICON_CHECK, { size: 14 }), attachLabel) as HTMLButtonElement)
    : (h("button", { "data-dp": "add-source-attach-panel.button.attach#2", class: "btn btn--primary", type: "button" }, svgIcon(ICON_CHECK, { size: 14 }), attachLabel) as HTMLButtonElement);
  // The shared refusal primitive, so the reason is the button's DESCRIPTION and its name stays
  // "Attach this source" rather than "Attach this source : an Owner attaches sources".
  if (!ownerGate) refuseWithReason(attachBtn, gateReason("owner"));
  const tokenHelpLink = h("button", { "data-dp": "add-source-attach-panel.button.token-help-link", class: "linklike", type: "button" }, "How do I create the deploy token?") as HTMLButtonElement;

  const attachErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const resultHost = h("div", { style: "margin-top:var(--space-3)" });

  bindingSteps.appendChild(h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-3)" }, tokenInput, attachBtn));
  bindingSteps.appendChild(
    ownerGate
      ? h(
          "p",
          { class: "field__hint", style: "margin-top:var(--space-2)" },
          tokenHelpLink,
          " The token edits the engine worker once, then you revoke it. The running engine holds no Cloudflare deploy token; it reaches your data only through bindings.",
        )
      : h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, `${gateReason("owner")} Attaching changes the engine's bindings.`),
  );
  bindingSteps.appendChild(attachErr);
  bindingSteps.appendChild(resultHost);

  // The no-token fallback, demoted to a disclosure: no customer is expected to run a terminal,
  // but an operator who prefers their own wrangler login keeps the option. The stanza is
  // regenerated from the CURRENT identifiers (the screen's refreshCli) so it never drifts from
  // what would be attached.
  const cliCodeHost = h("div");
  bindingSteps.appendChild(
    collapsedSection(
      "Prefer no token? Apply it with your own wrangler login",
      h(
        "div",
        { class: "stack-sm" },
        h("p", { class: "field__hint", style: "margin:0" }, "wrangler uses your own Cloudflare login, so this needs no token. Add the stanza to engine/wrangler.toml and run the deploy from the engine directory on a trusted machine."),
        cliCodeHost,
      ),
    ),
  );

  return { bindingSteps, formError, tokenInput, attachLabel, attachBtn, tokenHelpLink, attachErr, resultHost, cliCodeHost };
}
