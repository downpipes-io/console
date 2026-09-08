// Secrets repeater section for the upsert editor (the { name, binding } rows), split out of
// ./editor-upsert.ts (move-only). See ./editor.ts for the barrel.

import { h, svgIcon } from "../../lib/dom.ts";
import { field, type Field } from "../../components/field.ts";
import { matchingPattern } from "../../components/field-bounds.ts";
import { BINDING_NAME_PATTERN, RESOURCE_NAME_PATTERN } from "../../lib/add-source.ts";
import { ICON_PLUS, ICON_TRASH, ICON_EXTERNAL } from "../../lib/icons.ts";
import type { Downpipe } from "../../api.ts";
import type { EditorPrefill } from "./editor-types.ts";

// buildSecretsSection builds the secrets repeater (the previously-unreachable layer, G2): a list of
// { name, binding } rows the operator can add, remove or rename inline. When editing an existing
// secrets-type downpipe the repeater is pre-populated from existing?.source.secrets so the operator
// can change secrets without a full delete-and-recreate cycle. It is a self-contained closure: it
// owns its rows and exposes getSecrets() (the filtered wire shape), fields() (the started rows' handles,
// so the save can run each row's own pattern before building the request) plus focusFirst() (for the
// "needs at least one secret" submit error).
export function buildSecretsSection(
  existing: Downpipe | null,
  prefill: EditorPrefill | undefined,
  editing: boolean,
): {
  el: HTMLElement;
  getSecrets: () => Array<{ name: string; binding: string; storeId?: string }>;
  fields: () => Field[];
  focusFirst: () => void;
} {
  // storeId rides INVISIBLY on each row: it is the secret's Secrets Store id (recorded so a roster
  // re-attach can rebuild the binding), an immutable resource id the operator never edits, so it carries
  // through from the prefill / existing config rather than appearing as a field.
  const secretRows: Array<{ nameF: Field; bindingF: Field; row: HTMLElement; storeId?: string }> = [];
  const secretsRepeater = h("div", { class: "secrets-repeater" });
  // Monotonic id seed: deterministic and collision-free, so two rows never share a field id.
  let idSeq = 0;
  const addSecretRow = (preset?: { name: string; binding: string; storeId?: string }): void => {
    const i = ++idSeq;
    // Both boxes state their shape in the hint and, until now, took anything. A row whose name or
    // binding the engine will not take is DROPPED at submit only when it is entirely EMPTY
    // (getSecrets below); a row with a malformed name went to the engine and came back a 400 against
    // the whole downpipe, naming no row. Blank stays valid on both, because a blank row is the
    // repeater's own "unused row" state, not an unfinished entry.
    const nameF = field({ id: `dp-secret-name-${i}`, label: "Secret name", value: preset?.name ?? "", placeholder: "API_KEY", autocomplete: "off", hint: "The secret's name in your Cloudflare Secrets Store (a leading letter or digit, then letters, digits, hyphens or underscores). This is the record name that is backed up; no value is ever entered here.", validate: matchingPattern({ pattern: RESOURCE_NAME_PATTERN, rule: "A secret name must be 1 to 64 characters, starting with a letter or digit, then letters, digits, hyphens or underscores.", remedy: "Correct it to the name your Secrets Store shows, for example API_KEY." }), doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "binding-names-and-the-secrets-store" } });
    const bindingF = field({ id: `dp-secret-binding-${i}`, label: "Binding", value: preset?.binding ?? "", placeholder: "SRC_SECRET_apikey", autocomplete: "off", hint: "The Worker binding name the engine reads this secret through (a leading letter or underscore, then letters, digits or underscores, up to 64). Often the same as the secret name.", validate: matchingPattern({ pattern: BINDING_NAME_PATTERN, rule: "A binding must be 1 to 64 characters, starting with a letter or underscore, then letters, digits or underscores.", remedy: "Correct it to the binding the engine reads this secret through, for example SRC_SECRET_apikey." }), doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "binding-names-and-the-secrets-store" } });
    nameF.control.classList.add("mono");
    bindingF.control.classList.add("mono");
    // A DISTINCT ACCESSIBLE NAME PER ROW, and no change to what anyone sees.
    //
    // Every row's two fields carried the labels "Secret name" and "Binding", so a repeater holding five
    // secrets announced five controls with one name each to assistive technology, with nothing to say
    // which row was being edited. Found by the state walk three doors in, behind the advanced editor,
    // the Secrets choice and Add secret.
    //
    // aria-label rather than a per-row visible label, because the rows are not numbered on screen: a
    // visible "Secret 2: name" would introduce a number the reader has nothing to match it against.
    // The accessible name still OPENS with the visible label, which is what Label in Name (WCAG 2.5.3)
    // requires of a voice-control user saying the words they can see.
    //
    // The custody ceremony solves the same problem the other way, per-share visible labels, because
    // there the shares ARE numbered on screen and the field beside it was already named that way.
    nameF.control.setAttribute("aria-label", `Secret name, row ${i}`);
    bindingF.control.setAttribute("aria-label", `Binding, row ${i}`);
    const delBtn = h(
      "button",
      // Named per row for the same reason as the two fields above. This one is invisible to the
      // duplicate-name oracle, which collects input, select and textarea and not buttons, so five
      // identical "Remove this secret" buttons were never reported. Fixed here because it is the same
      // defect in the same loop, and recorded separately because the oracle cannot see its class.
      { "data-dp": "sources-downpipes.button.del#2", class: "btn btn--ghost btn--icon secrets-repeater__del", type: "button", "aria-label": `Remove secret, row ${i}` },
      svgIcon(ICON_TRASH, { size: 16 }),
    );
    // The delete button reserves a label line so it sits on the fields' control line rather than on
    // the bottom edge of a box whose height a hint or an error can change. The spacer is a
    // real `.field__label` so it is exactly the line box the sibling labels occupy; it is aria-hidden
    // because the button already carries its own accessible name.
    const delCell = h(
      "div",
      { class: "secrets-repeater__del-cell" },
      h("span", { class: "field__label", "aria-hidden": "true" }, "\u00a0"),
      delBtn,
    );
    const row = h("div", { class: "secrets-repeater__row" }, nameF.el, bindingF.el, delCell);
    const entry = { nameF, bindingF, row, ...(preset?.storeId ? { storeId: preset.storeId } : {}) };
    delBtn.addEventListener("click", () => {
      if (secretRows.length <= 1) return; // keep at least one row
      const idx = secretRows.indexOf(entry);
      if (idx >= 0) secretRows.splice(idx, 1);
      row.remove();
    });
    secretRows.push(entry);
    secretsRepeater.appendChild(row);
  };
  // Pre-populate from the existing config when editing (console-sources-3: an operator
  // editing a secrets downpipe can add or remove secrets without a full recreate). A fresh
  // editor reached from the add-source flow seeds the first row's binding from the prefill
  // (the Secrets Store binding the operator just deployed), so the journey carries through.
  for (const s of existing?.source.secrets ?? []) addSecretRow(s);
  if (secretRows.length === 0) {
    addSecretRow(prefill?.secretBinding ? { name: "", binding: prefill.secretBinding, ...(prefill.secretStoreId ? { storeId: prefill.secretStoreId } : {}) } : undefined);
  }
  const addSecretBtn = h(
    "button",
    { "data-dp": "sources-downpipes.button.add-secret", class: "btn btn--secondary btn--sm", type: "button", style: "align-self:flex-start", on: { click: () => { addSecretRow(); secretRows[secretRows.length - 1]?.nameF.focus(); } } },
    svgIcon(ICON_PLUS, { size: 14 }),
    "Add secret",
  );
  const secretsHint = h(
    "p",
    { class: "field__hint" },
    editing && existing?.source.type === "secrets"
      ? "Existing secrets are shown. Add rows to back up more; remove rows to stop backing up a secret. Save changes to apply."
      : "Add one row per secret. Each row maps a human label to the Secrets Store binding name.",
  );
  const el = h(
    "div",
    { class: "field", hidden: (existing?.source.type ?? prefill?.type ?? "kv") !== "secrets" },
    h("span", { class: "field__label" }, "Secrets to back up"),
    secretsHint,
    secretsRepeater,
    addSecretBtn,
    // Group-level doc link (audit G2): the repeated name + binding rows share one concept (the secret
    // name and its 1 to 64 char [A-Za-z0-9_] binding; no value is ever entered), so the link lives on
    // the section rather than under every row.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/connect-a-source#binding-names-and-the-secrets-store", target: "_blank", rel: "noreferrer noopener" },
      "About secret names and bindings",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );

  return {
    el,
    getSecrets: () =>
      secretRows
        .map((r) => ({ name: r.nameF.value(), binding: r.bindingF.value(), ...(r.storeId ? { storeId: r.storeId } : {}) }))
        .filter((s) => s.name !== "" && s.binding !== ""),
    // The handles of every row the operator has started, so the save can run each row's OWN rule before
    // building the request. Without this the two patterns here were blur-only: the engine's name check is
    // length-only (1 to 256, engine/src/sched/config-validate.ts:377) and its binding check permits a
    // LEADING DIGIT, so a name with a space and a binding like "9BAD" both stored intact under a field the
    // console had already marked bad. A row with neither box filled is the repeater's idle state and is
    // skipped, matching getSecrets, which drops it.
    fields: (): Field[] => secretRows.filter((r) => r.nameF.value() !== "" || r.bindingF.value() !== "").flatMap((r) => [r.nameF, r.bindingF]),
    focusFirst: () => secretRows[0]?.nameF.focus(),
  };
}
