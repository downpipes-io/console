// The "Add a source" disclosure body and the guided add-source wizard for the Sources
// screen. addSourceBody is the disclosed add action (mirroring "Add a destination" on
// Destinations); openAddSourceWizard is the modal attach flow (choose a type, pick the
// resource(s), then paste a one-shot deploy token and attach). Attach targets the
// ENGINE's own account; bindings cannot cross accounts. Moved here verbatim so the
// add action, the drift re-attach and any future caller share the wizard without a
// cycle. Australian English, no em dashes, precise claims.

import { type EngineClient, isOwnerActionQueuedResult, type SourceDiscovery } from "../../api.ts";
import { codeBlock } from "../../components/code-block.ts";
import { dialogSurface, openOverlay } from "../../components/dialog.ts";
import { SESSION_ENDED_ACTION } from "../../components/error-view.ts";
import { toast } from "../../components/toast.ts";
import { stepper } from "../../components/wizard.ts";
import { type SourceInput, wranglerStanza } from "../../lib/add-source.ts";
import { h, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { collapsedSection, gateReason } from "../common.ts";
import { errMsg, type ProtectType, pickIcon, pickTypeLabel, selectableSourceList } from "./shared.ts";
import { attachTokenHelp } from "./token-help.ts";

// openAddSourceWizard is the guided attach flow, mirroring the Downpipes create wizard
// (a modal with a step rail + step body + footer nav): choose a type, pick the
// resource(s) from the catalogue, then paste a one-shot deploy token and attach. Attach
// targets the ENGINE's own account (bindings cannot cross accounts); resources already
// attached are filtered out. Reuses the same primitives the page used inline
// (selectableSourceList / changeBindings / attachTokenHelp / wranglerStanza), so the
// behaviour and safety checks are unchanged, only the chrome is a tidy wizard.
interface PickItem { key: string; name: string; input: SourceInput; }

// WizardCtx is the shared, mutable state the add-source wizard's step renderers operate on. It is built once
// in openAddSourceWizard and threaded to the (module-level) step renderers, so each renderer is a small named
// function with explicit inputs rather than a closure over openAddSourceWizard's locals. step / chosenType are
// mutable; renderStep re-paints the rail + the active step body.
interface WizardCtx {
  engine: EngineClient;
  found: SourceDiscovery;
  refresh: () => void;
  ownerGate: boolean;
  engAcct: NonNullable<SourceDiscovery["accounts"]>[number] | null;
  itemsFor: (type: ProtectType) => PickItem[];
  chosen: Map<string, SourceInput>;
  step: number; // 0 = choose type, 1 = pick resources, 2 = attach
  chosenType: ProtectType | null;
  stepHost: HTMLElement;
  nextBtn: HTMLButtonElement;
  handle: { close: () => void };
  renderStep: () => void;
}

export function openAddSourceWizard(engine: EngineClient, found: SourceDiscovery, refresh: () => void, ownerGate: boolean): void {
  const engAcct = (found.accounts ?? []).find((a) => found.engineAccountId !== null && a.accountId === found.engineAccountId) ?? null;
  const boundSet = new Set<string>([...found.bound.kv, ...found.bound.r2, ...found.bound.d1, ...found.bound.secrets]);
  const bindingFor = (prefix: string, name: string): string => `${prefix}${name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;

  // Secret names can repeat across stores; suffix the store id only when more than one store is
  // listed, so the common single-store account reads clean names.
  const secretStores = new Set((engAcct?.secrets ?? []).map((s) => s.storeId));
  const secretLabel = (name: string, storeId: string): string =>
    secretStores.size > 1 ? `${name} (store ${storeId.slice(-6)})` : name;
  const itemsFor = (type: ProtectType): PickItem[] => {
    if (!engAcct) return [];
    const raw: PickItem[] =
      type === "kv" ? engAcct.kv.map((n) => ({ key: `kv:${n.id}`, name: n.name, input: { type: "kv", binding: bindingFor("SRC_KV_", n.name), namespaceId: n.id } as SourceInput }))
      : type === "r2" ? engAcct.r2.map((b) => ({ key: `r2:${b.name}`, name: b.name, input: { type: "r2", binding: bindingFor("SRC_R2_", b.name), bucketName: b.name } as SourceInput }))
      : type === "d1" ? engAcct.d1.map((d) => ({ key: `d1:${d.id}`, name: d.name, input: { type: "d1", binding: bindingFor("SRC_D1_", d.name), databaseName: d.name, databaseId: d.id } as SourceInput }))
      : engAcct.secrets.map((sec) => ({ key: `sec:${sec.storeId}:${sec.name}`, name: secretLabel(sec.name, sec.storeId), input: { type: "secrets", binding: bindingFor("SRC_SEC_", sec.name), storeId: sec.storeId, secretName: sec.name } as SourceInput }));
    // Only what is NOT already attached: the wizard is for adding new sources.
    return raw.filter((i) => !boundSet.has(i.input.binding));
  };

  const steps = [
    { id: "type", label: "Choose" },
    { id: "pick", label: "Pick what to back up" },
    { id: "attach", label: "Attach" },
  ];
  const stepRail = h("div");
  const stepHost = h("div", { class: "stack-sm" });
  const cancelBtn = h("button", { "data-dp": "sources.button.cancel", class: "btn btn--ghost", type: "button" }, "Cancel");
  const backBtn = h("button", { "data-dp": "sources.button.back", class: "btn btn--secondary", type: "button", hidden: true }, "Back") as HTMLButtonElement;
  const nextBtn = h("button", { "data-dp": "sources.button.next", class: "btn btn--primary", type: "button", disabled: true }, "Continue") as HTMLButtonElement;
  // The manual escape hatch lives in the wizard's own footer (left side), so the by-id path stays
  // one click away without a separate disclosure on the screen (the header primary opens this
  // wizard directly, matching New downpipe and Add a destination).
  const manualLink = h(
    "button",
    { "data-dp": "sources.button.manual-link", class: "linklike", type: "button", style: "margin-right:auto", on: { click: () => { handle.close(); navigate("/sources/advanced"); } } },
    "Add by id manually",
  );
  const footer = h("div", { class: "dialog__actions" }, manualLink, cancelBtn, backBtn, nextBtn);
  const body = h("div", { class: "form-stack" }, stepRail, stepHost);
  const { surface } = dialogSurface({ variant: "modal", title: "Add a source", body, footer, onCloseClick: () => handle.close() });
  const handle = openOverlay({ surface, variant: "modal", dismissable: false });

  const ctx: WizardCtx = {
    engine, found, refresh, ownerGate, engAcct, itemsFor,
    chosen: new Map<string, SourceInput>(),
    step: 0, chosenType: null, stepHost, nextBtn, handle,
    renderStep: () => {},
  };
  ctx.renderStep = (): void => {
    stepRail.replaceChildren(stepper({ steps, currentIndex: ctx.step, onJump: (_s, i) => { if (i < ctx.step) { ctx.step = i; ctx.renderStep(); } } }));
    backBtn.hidden = ctx.step === 0;
    if (ctx.step === 0) renderTypeStep(ctx);
    else if (ctx.step === 1) renderPickStep(ctx);
    else renderAttachStep(ctx);
  };

  cancelBtn.addEventListener("click", () => handle.close());
  backBtn.addEventListener("click", () => { if (ctx.step > 0) { ctx.step--; ctx.renderStep(); } });
  nextBtn.addEventListener("click", () => { if (ctx.step < 2) { ctx.step++; ctx.renderStep(); } });

  ctx.renderStep();
}

// manualLink is the "Add by id manually" escape hatch shown on the pick/attach steps.
function manualLink(handle: { close: () => void }): HTMLElement {
  return h("p", { class: "field__hint", style: "margin:0" }, "Can't see it? ", h("button", { "data-dp": "sources.button.navigate-sources-advanced#2", class: "linklike", type: "button", on: { click: () => { handle.close(); navigate("/sources/advanced"); } } }, "Add by id manually"), ".");
}

// renderTypeStep paints step 0: the source-type radiogroup (kv / r2 / d1) with the not-yet-attached count
// per type. With no engine-owned account set there is nothing to attach to, so it explains how to set one.
function renderTypeStep(ctx: WizardCtx): void {
  const { engAcct, itemsFor, stepHost, nextBtn } = ctx;
  nextBtn.hidden = false;
  nextBtn.textContent = "Continue";
  nextBtn.disabled = ctx.chosenType === null;
  if (!engAcct) {
    nextBtn.disabled = true;
    stepHost.replaceChildren(
      h("p", { class: "field__hint" }, "No account is marked as the engine's own yet, so there is nothing to attach to. Set it under “Browse the full catalogue and manage your connected account” → Choose accounts, then come back."),
    );
    return;
  }
  const seg = h("div", { role: "radiogroup", "aria-label": "Source type", style: "display:flex;gap:var(--space-2);flex-wrap:wrap" });
  for (const t of ["kv", "r2", "d1", "secrets"] as ProtectType[]) {
    const on = ctx.chosenType === t;
    const count = itemsFor(t).length;
    const btn = h(
      "button",
      { "data-dp": "sources.radio.render-step", class: on ? "btn btn--primary btn--sm" : "btn btn--secondary btn--sm", type: "button", role: "radio", "aria-checked": on ? "true" : "false", style: "display:inline-flex;align-items:center;gap:var(--space-1)" },
      svgIcon(pickIcon(t), { size: 14 }),
      h("span", `${pickTypeLabel(t)}s`),
      h("span", { class: "field__hint" }, `(${count})`),
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => { ctx.chosenType = t; ctx.chosen.clear(); ctx.renderStep(); });
    seg.appendChild(btn);
  }
  stepHost.replaceChildren(
    h("p", { class: "field__hint" }, "What kind of resource do you want to back up? Only resources not already attached are shown."),
    seg,
    // Group-level doc link: the type radios are one control, so the link explaining what each
    // source type captures lives on the group, not on a single button.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/overview#the-eight-source-types", target: "_blank", rel: "noreferrer noopener" },
      "About the source types",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
  );
}

// renderPickStep paints step 1: the not-yet-attached resources of the chosen type as a tickable list (the
// selection feeds ctx.chosen). With nothing new to attach it points at the manual-by-id path.
function renderPickStep(ctx: WizardCtx): void {
  const { itemsFor, stepHost, nextBtn, handle } = ctx;
  nextBtn.hidden = false;
  nextBtn.textContent = "Continue";
  nextBtn.disabled = ctx.chosen.size === 0;
  const type = ctx.chosenType ?? "kv";
  const items = itemsFor(type);
  if (items.length === 0) {
    nextBtn.disabled = true;
    stepHost.replaceChildren(
      h("p", { class: "field__hint" }, `Nothing new to attach in ${pickTypeLabel(type)}s, everything visible is already attached, or the token's scopes show none.`),
      manualLink(handle),
    );
    return;
  }
  const inputByKey = new Map(items.map((i) => [i.key, i.input]));
  const list = selectableSourceList({
    groupId: `add-${type}`,
    label: `${pickTypeLabel(type)}s`,
    icon: pickIcon(type),
    open: true,
    items: items.map((i) => ({ value: i.key, label: i.name, checked: ctx.chosen.has(i.key) })),
    onToggle: (value, checked) => {
      const inp = inputByKey.get(value);
      if (checked && inp) ctx.chosen.set(value, inp);
      else ctx.chosen.delete(value);
      nextBtn.disabled = ctx.chosen.size === 0;
    },
  });
  stepHost.replaceChildren(
    h("p", { class: "field__hint" }, "Tick what to attach (you can attach several at once), then Continue."),
    list,
    ...(type === "secrets"
      ? [h("p", { class: "field__hint", style: "margin:0" },
          "Each ticked secret mounts as its own read-only binding on the engine (the only way a Worker can read a Secrets Store value). Once attached, protect them from Sources or the create wizard; a Secrets downpipe bundles them and captures each value sealed.")]
      : []),
    manualLink(handle),
  );
}

// renderAttachStep paints step 2: the one-shot deploy token + Attach (Owner-gated, the engine enforces),
// plus the no-token wrangler escape hatch. Attach adds the chosen bindings to the engine, verifies its own
// bindings survive, then the operator revokes the token.
function renderAttachStep(ctx: WizardCtx): void {
  const { engine, found, refresh, ownerGate, stepHost, nextBtn, handle } = ctx;
  const inputs = [...ctx.chosen.values()];
  if (!ownerGate) {
    nextBtn.hidden = true;
    stepHost.replaceChildren(
      h("p", { class: "field__hint" }, `${gateReason("owner")} Attaching changes the engine's bindings, so an Owner completes this step.`),
    );
    return;
  }
  nextBtn.hidden = true; // the Attach action lives in the step body, beside the token.
  const tokenInput = h("input", { "data-dp": "sources.password.token#2", class: "input", type: "password", autocomplete: "off", "aria-label": "One-shot deploy token", placeholder: "paste a deploy token (used once, never stored)" }) as HTMLInputElement;
  const attachBtn = h("button", { "data-busy-label": "Attaching", "data-dp": "sources.button.attach#3", class: "btn btn--primary btn--sm", type: "button" }, `Attach ${inputs.length}`) as HTMLButtonElement;
  const attachErr = h("p", { class: "field__error", role: "alert", hidden: true });
  attachBtn.addEventListener("click", () => {
    const value = tokenInput.value.trim();
    if (value === "") { attachErr.textContent = "Paste the deploy token first."; attachErr.hidden = false; return; }
    attachErr.hidden = true;
    attachBtn.disabled = true;
    attachBtn.textContent = "Attaching";
    void engine
      .changeBindings(value, inputs, [])
      .then((res) => {
        if (isOwnerActionQueuedResult(res)) {
          surfaceQueuedOwnerAction("Attaching these sources");
          handle.close();
          refresh();
          return;
        }
        const { attached } = res.value;
        toast({ message: `${attached.length} source${attached.length === 1 ? "" : "s"} attached, verified safe. Revoke the token now. They appear under Attached, ready to protect.` });
        handle.close();
        refresh();
      })
      .catch((e) => {
        if (isUnauthorised(e)) {
          // PAINT FIRST, THEN LEAVE: nothing was attached, so the control comes back off "Attaching".
          attachErr.textContent = SESSION_ENDED_ACTION;
          attachErr.hidden = false;
          attachBtn.disabled = false;
          attachBtn.textContent = `Attach ${inputs.length}`;
          return goSignedOut();
        }
        attachErr.textContent = errMsg(e);
        attachErr.hidden = false;
        attachBtn.disabled = false;
        attachBtn.textContent = `Attach ${inputs.length}`;
      });
  });
  stepHost.replaceChildren(
    h("p", { class: "field__hint" }, `Attaching ${inputs.length} source${inputs.length === 1 ? "" : "s"}. The engine adds these bindings to itself, proves none of its own are dropped, applies the change and re-reads to verify, then you revoke the token.`),
    h("ul", { class: "stack-xs", style: "list-style:none;padding:0;margin:0" }, ...inputs.map((i) => h("li", { class: "mono", style: "color:var(--text-muted)" }, i.binding))),
    h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, tokenInput, attachBtn),
    h("p", { class: "field__hint", style: "margin:0" }, h("button", { "data-dp": "sources.button.attach-token-help#2", class: "linklike", type: "button", on: { click: () => attachTokenHelp(found.engineAccountId ?? null) } }, "How do I create the deploy token?"), " It is used once for this change, never stored."),
    attachErr,
    collapsedSection(
      "Prefer no token? Deploy it yourself",
      h(
        "div",
        { class: "stack-sm" },
        h("p", { class: "field__hint", style: "margin:0" }, "wrangler uses your own Cloudflare login, so this needs no token. Add the stanzas to engine/wrangler.toml and deploy from the engine directory:"),
        codeBlock(inputs.map((i) => wranglerStanza(i)).join("\n\n"), { copyLabel: "Copy the bindings", label: "1. Add to engine/wrangler.toml" }),
        codeBlock("npm run deploy", { copyLabel: "Copy the command", label: "2. Then run from engine/" }),
        h(
          "p",
          { class: "field__hint", style: "margin:0" },
          "The guided deploy re-checks the engine's live bindings first, so it cannot drop the sources you attached from the console. Never run a bare wrangler deploy here. ",
          h(
            "a",
            { class: "linklike", href: "https://docs.downpipes.io/operations/deploy-safety-bindings", target: "_blank", rel: "noreferrer noopener" },
            "Why this matters",
          ),
        ),
      ),
    ),
  );
}
