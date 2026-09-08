// The live-binding confirmation for the "attach a source manually" screen (add-source.ts): once
// the engine has attached a binding to itself, this builds the success surface, the bridge into the
// existing add-downpipe editor (binding + store type prefilled), and the optional wrangler.toml sync
// reminder. Pulled out of the screen so the attach flow stays small. It depends only on the attached
// input and the draft key, no closure state, so the behaviour is byte-identical to before.
//
// House: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../lib/dom.ts";
import { collapsedSection } from "./common.ts";
import { navigate } from "../lib/nav.ts";
import { clearDraft } from "../lib/draft.ts";
import { codeBlock } from "../components/code-block.ts";
import { verdictSurface } from "../components/verdict.ts";
import { ICON_CHECK } from "../lib/icons.ts";
import { storeTypeLabel, wranglerStanza, type SourceInput } from "../lib/add-source.ts";

// renderAttachSuccess builds the live-binding confirmation + the bridge into the existing
// add-downpipe editor (binding + store type prefilled), plus the optional wrangler.toml sync
// reminder (so a LATER manual deploy, which rewrites bindings wholesale, preserves this one).
export function renderAttachSuccess(input: SourceInput, draftKey: string): HTMLElement {
  const box = h("div");
  box.appendChild(
    verdictSurface({
      tone: "trust",
      glyph: ICON_CHECK,
      title: `The ${storeTypeLabel(input.type)} binding ${input.binding.trim()} is live`,
      body: "The engine attached it and re-read its bindings to confirm nothing else changed. Revoke the deploy token now, then configure a downpipe to start protecting it.",
    }),
  );

  const params = new URLSearchParams({ binding: input.binding.trim(), type: input.type });
  // The param carries the binding NAME (not a secret value or the store entry key), so it is named
  // secretBinding to match the EditorPrefill field it seeds; nothing secret rides on this URL.
  if (input.type === "secrets") params.set("secretBinding", input.binding.trim());
  // Carry the native resource id too (the operator just attached it, so we KNOW it), so the new downpipe
  // records it with zero manual entry and is roster-rebuildable on re-attach. A non-secret account id.
  if (input.type === "kv") params.set("namespaceId", input.namespaceId.trim());
  else if (input.type === "r2") params.set("bucketName", input.bucketName.trim());
  else if (input.type === "d1") params.set("databaseId", input.databaseId.trim());
  else if (input.type === "secrets") params.set("storeId", input.storeId.trim());
  const to = `/downpipes/new?${params.toString()}`;
  const configureBtn = h(
    "button",
    { "data-dp": "add-source-success.button.configure", class: "btn btn--primary", type: "button" },
    svgIcon(ICON_CHECK, { size: 14 }),
    "Configure a downpipe for this binding",
  ) as HTMLButtonElement;
  configureBtn.addEventListener("click", () => {
    clearDraft(draftKey);
    navigate(to);
  });
  box.appendChild(h("div", { class: "ob-actions", style: "margin-top:var(--space-3)" }, configureBtn));

  box.appendChild(
    collapsedSection(
      "Keep engine/wrangler.toml in step (optional)",
      h(
        "div",
        { class: "stack-sm" },
        h("p", { class: "field__hint", style: "margin:0" }, "The binding is live now. A later MANUAL wrangler deploy rewrites the engine's bindings wholesale, so add this stanza to engine/wrangler.toml when convenient and a future deploy preserves it."),
        codeBlock(wranglerStanza(input), { copyLabel: "Copy the stanza", label: "Sync into engine/wrangler.toml" }),
      ),
    ),
  );
  return box;
}
