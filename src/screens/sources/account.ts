// Tier 3 of the Sources screen: the account-wide catalogue (multi-account for larger
// orgs). The engine's account gets the no-terminal attach flow (ticks -> generated
// stanzas + a bounded deploy poll); every other account lists its resource names
// read-only with the honest cross-account boundary. Token management (choose accounts,
// replace, remove) lives behind one disclosure here. Moved here verbatim from the screen
// module for size; it imports the shared leaf, the token-entry form and the deploy-token
// help. Australian English, no em dashes, precise claims.

import type { EngineClient, SourceDiscovery } from "../../api.ts";
import { isOwnerActionQueuedResult } from "../../api.ts";
import { codeBlock } from "../../components/code-block.ts";
import { SESSION_ENDED_ACTION } from "../../components/error-view.ts";
import { confirmModal } from "../../components/modal.ts";
import { requireChange } from "../../components/require-change.ts";
import { badge } from "../../components/status.ts";
import { toast } from "../../components/toast.ts";
import { type SourceInput, wranglerStanza } from "../../lib/add-source.ts";
import { recordDiscoveryConnect } from "../../lib/client-diag/ring.ts";
import { h, refuseWithReason, svgIcon } from "../../lib/dom.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { relativeTime } from "../../lib/format.ts";
import { ICON_EXTERNAL } from "../../lib/icons.ts";
import { goSignedOut, navigate } from "../../lib/nav.ts";
import { surfaceQueuedOwnerAction } from "../../lib/pending-change-toast.ts";
import { collapsedSection, gateReason } from "../common.ts";
import { errMsg, ICON_D1, ICON_KV, ICON_R2, type PollHooks, selectableSourceList, WAIT_POLL_MAX, WAIT_POLL_MS } from "./shared.ts";
import { tokenEntry } from "./token-entry.ts";
import { attachTokenHelp } from "./token-help.ts";

// AccountTierCtx threads the per-render state through the extracted sub-builders so each
// stays a small named unit while sharing exactly the closures the original inline body
// did. Nothing here is new state: it is the same locals, named once.
interface AccountTierCtx {
  engine: EngineClient;
  found: SourceDiscovery;
  piped: ReadonlySet<string>;
  refresh: () => void;
  ownerGate: boolean;
  polls: PollHooks;
  // The unbound selection: key -> the exact stanza input for wranglerStanza.
  chosen: Map<string, SourceInput>;
  stanzaHost: HTMLElement;
  genBtn: HTMLButtonElement;
  // The attach panel is built ONCE (so a half-typed deploy token survives) and then
  // kept in step with the live selection: every checkbox change re-syncs the count and
  // the stanzas via updateGen, so the attach never acts on a stale capture.
  syncPanel: { fn: (() => void) | null };
  updateGen: () => void;
}

// accountTier renders tier 3: the account-wide catalogue (multi-account for larger
// orgs). The engine's account gets the attach flow; every other account lists its
// resource names read-only with the honest cross-account boundary. Token
// management (choose accounts, replace, remove) lives behind one disclosure here.
export function accountTier(engine: EngineClient, found: SourceDiscovery, piped: ReadonlySet<string>, refresh: () => void, ownerGate: boolean, polls: PollHooks): HTMLElement {
  const section = h("section");
  section.appendChild(h("h3", { class: "section-title" }, "Across your accounts"));

  if (!found.tokenPresent) {
    section.appendChild(
      h(
        "p",
        { class: "field__hint" },
        "The tiers above show only what is bound to the engine. To browse everything you own, connect your account:",
      ),
    );
    section.appendChild(tokenEntry(engine, ownerGate, "Verify and save", refresh));
    return section;
  }

  const chosen = new Map<string, SourceInput>();
  const stanzaHost = h("div");
  const syncPanel: { fn: (() => void) | null } = { fn: null };
  // justify-self keeps the button its natural width inside the .stack-sm grid column
  // (an unstyled grid child stretches the full track, a wall-to-wall disabled button).
  const genBtn = h("button", { "data-dp": "sources.button.gen", class: "btn btn--secondary btn--sm", type: "button", disabled: true, style: "justify-self:start" }, "Attach selected to the engine") as HTMLButtonElement;
  const updateGen = (): void => {
    genBtn.disabled = chosen.size === 0;
    genBtn.textContent = chosen.size === 0 ? "Attach selected to the engine" : `Attach ${chosen.size} to the engine`;
    syncPanel.fn?.();
  };
  const ctx: AccountTierCtx = { engine, found, piped, refresh, ownerGate, polls, chosen, stanzaHost, genBtn, syncPanel, updateGen };

  const body = h("div", { class: "stack-sm" });

  // The management row: who enabled browsing, the accounts, and the levers.
  const mgmtHost = h("div", { class: "stack-sm" });
  body.appendChild(mgmtHost);
  mountManagementRow(ctx, mgmtHost);

  if ((found.accountErrors ?? []).length > 0) {
    body.appendChild(
      h(
        "p",
        { class: "field__hint" },
        `Some listings failed (check the token's read scopes): ${(found.accountErrors ?? []).join("; ")}.`,
      ),
    );
  }

  renderAccountListings(ctx, body);

  if ((found.accounts ?? []).some((a) => found.engineAccountId !== null && a.accountId === found.engineAccountId)) {
    genBtn.addEventListener("click", () => {
      genBtn.hidden = true; // the panel below is now the one attach surface
      buildAttachPanel(ctx);
    });
    body.appendChild(genBtn);
    body.appendChild(stanzaHost);
  } else if ((found.accounts ?? []).length > 0 && found.engineAccountId === null) {
    body.appendChild(h("p", { class: "field__hint" }, "No account is marked as the engine's own yet; set it under Choose accounts to enable attaching."));
  }

  section.appendChild(body);
  section.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-3)" },
      "Prefer to type the ids yourself? ",
      h("button", { "data-dp": "sources.button.navigate-sources-advanced#1", class: "linklike", type: "button", on: { click: () => navigate("/sources/advanced") } }, "Attach a source manually"),
      ".",
    ),
  );
  return section;
}

// bindingFor sanitises a resource name into a wrangler binding identifier under a prefix.
function bindingFor(prefix: string, name: string): string {
  return `${prefix}${name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

// accountGroup renders one product group. selectable=false (a non-engine account)
// lists names read-only, the names are already fetched; hiding them behind a
// bare count helped nobody.
function accountGroup(ctx: AccountTierCtx, label: string, items: Array<{ key: string; name: string; input: SourceInput }>, selectable: boolean): HTMLElement | null {
  const { found, piped, chosen, updateGen } = ctx;
  if (items.length === 0) return null;
  const iconFor = label.startsWith("KV") ? ICON_KV : label.startsWith("R2") ? ICON_R2 : label.startsWith("D1") ? ICON_D1 : ICON_KV;
  const inputByKey = new Map(items.map((i) => [i.key, i.input]));
  return selectableSourceList({
    groupId: `acct-${label.replace(/[^A-Za-z0-9]+/g, "-")}`,
    label,
    icon: iconFor,
    items: items.map((item) => {
      const maybeBound = piped.has(item.input.binding) || found.bound.kv.includes(item.input.binding) || found.bound.r2.includes(item.input.binding) || found.bound.d1.includes(item.input.binding);
      return { value: item.key, label: item.name, checked: chosen.has(item.key), badge: maybeBound ? badge("default", "already attached") : null };
    }),
    ...(selectable
      ? {
          onToggle: (value: string, checked: boolean) => {
            const input = inputByKey.get(value);
            if (checked && input) chosen.set(value, input);
            else chosen.delete(value);
            updateGen();
          },
        }
      : {}),
  });
}

// mountManagementRow draws the "who enabled browsing, the accounts, and the levers" block.
// It reads discovery status asynchronously; the presence read is advisory, so the listing
// below still renders if it fails.
function mountManagementRow(ctx: AccountTierCtx, mgmtHost: HTMLElement): void {
  const { engine, ownerGate, refresh } = ctx;
  void engine
    .getDiscoveryStatus()
    .then((st) => {
      if (!st.present) return; // raced a removal; the next refresh renders the enable form
      const seen = st.accountsSeen ?? [];
      const selectedIds = st.selected ?? [];
      const line = h(
        "p",
        { class: "field__hint" },
        `Account browsing is on: ${selectedIds.length} of ${seen.length} account${seen.length === 1 ? "" : "s"} browsed`,
        st.setAt ? `, set ${relativeTime(new Date(st.setAt).toISOString())}` : "",
        st.setBy ? ` by ${st.setBy}` : "",
        ".",
      );
      const chooseBtn = h("button", { "data-dp": "sources.button.choose", class: "linklike", type: "button" }, seen.length > 1 ? "Choose accounts" : "Account settings");
      const removeBtn = ownerGate
        ? (h("button", { "data-dp": "sources.button.remove#1", class: "linklike", type: "button", style: "color:var(--danger-fg)" }, "Remove token") as HTMLButtonElement)
        : (h("button", { "data-dp": "sources.button.remove#2", class: "linklike", type: "button" }, "Remove token") as HTMLButtonElement);
      // The shared refusal primitive: the reason becomes the button's description, so it announces
      // as "Remove token" rather than "Remove token : Requires the Owner role".
      if (!ownerGate) refuseWithReason(removeBtn, gateReason("owner"));
      const row = h("div", { style: "display:flex;gap:var(--space-4);flex-wrap:wrap" }, chooseBtn, removeBtn);
      const chooserHost = h("div");
      mgmtHost.appendChild(line);
      mgmtHost.appendChild(row);
      mgmtHost.appendChild(chooserHost);

      const renderChooser = (): void => renderAccountChooser(ctx, chooserHost, seen, selectedIds, st.engineAccountId ?? null);
      chooseBtn.addEventListener("click", renderChooser);
      // A multi-account token saved moments ago has no selection yet: open the
      // chooser unprompted so the next step is obvious.
      if (selectedIds.length === 0 && seen.length > 0) renderChooser();

      if (ownerGate) {
        removeBtn.addEventListener("click", () => {
          void confirmModal({
            title: "Remove the discovery token?",
            body: "Account browsing turns off immediately (already-attached sources and existing downpipes are untouched). You can paste a new token any time.",
            confirmLabel: "Remove",
            variant: "danger",
          }).then(async (okd) => {
            if (!okd) return;
            // Change management (owner opt-in): removing the account-browsing token is a change-controlled
            // action. Collect a change reference after the removal is confirmed (a no-op when the policy is off).
            const cr = await requireChange(engine, "Remove the account-browsing token", "discovery-token-clear");
            if (!cr.proceed) return;
            void engine
              .setDiscoveryToken(null, cr.change ?? undefined)
              .then((res) => {
                // Dual control armed: removing the token is queued for a second owner. Say so honestly; the
                // token is still in place until they approve, so do not imply it is gone (a refresh would
                // re-show it with no explanation).
                if (isOwnerActionQueuedResult(res)) { surfaceQueuedOwnerAction("Removing the account-browsing token"); return; }
                refresh();
              })
              .catch((e) => {
                if (isUnauthorised(e)) return goSignedOut();
                toast({ message: `Could not remove the token. ${errMsg(e)}`, tone: "warn" });
              });
          });
        });
      }
      mgmtHost.appendChild(collapsedSection("Replace the token", tokenEntry(engine, ownerGate, "Verify and replace", refresh)));
    })
    .catch(() => {
      /* presence read is advisory; the listing below still renders */
    });
}

// renderAccountChooser draws the per-account "browse / engine's account" picker into
// chooserHost and wires its save. Owner-gated: a non-owner sees the rows but the save is
// disabled with the gate reason.
function renderAccountChooser(
  ctx: AccountTierCtx,
  chooserHost: HTMLElement,
  seen: ReadonlyArray<{ id: string; name: string }>,
  selectedIds: ReadonlyArray<string>,
  engineAccountId: string | null,
): void {
  const { engine, ownerGate, refresh } = ctx;
  const boxes = new Map<string, HTMLInputElement>();
  const radios = new Map<string, HTMLInputElement>();
  const rows = h("div", { class: "stack-sm", role: "group", "aria-label": "Accounts to browse" });
  rows.appendChild(
    h(
      "div",
      { style: "display:flex;gap:var(--space-4)" },
      h("span", { class: "field__label", style: "flex:1" }, "Browse"),
      h("span", { class: "field__label" }, "Engine's account"),
    ),
  );
  for (const a of seen) {
    const boxId = `disc-browse-${a.id}`;
    const box = h("input", { type: "checkbox", id: boxId, ...(selectedIds.includes(a.id) ? { checked: true } : {}) }) as HTMLInputElement;
    const radio = h("input", { "data-dp": "sources.radio.account-chooser", type: "radio", name: "disc-engine-acct", "aria-label": `${a.name} is the engine's account`, ...(engineAccountId === a.id ? { checked: true } : {}) }) as HTMLInputElement;
    boxes.set(a.id, box);
    radios.set(a.id, radio);
    rows.appendChild(
      h(
        "div",
        { style: "display:flex;align-items:center;gap:var(--space-2)" },
        box,
        h("label", { for: boxId, style: "flex:1" }, a.name, h("span", { class: "field__hint", style: "display:block" }, a.id)),
        radio,
      ),
    );
  }
  const saveErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const saveBtn = h("button", { "data-dp": "sources.button.save#1", class: "btn btn--secondary btn--sm", type: "button" }, "Save accounts") as HTMLButtonElement;
  // The shared refusal primitive sets aria-disabled, the title and the described-by reason together,
  // so the name stays "Save accounts".
  if (!ownerGate) refuseWithReason(saveBtn, gateReason("owner"));
  if (ownerGate) {
    saveBtn.addEventListener("click", async () => {
      const chosenIds = seen.filter((a) => boxes.get(a.id)?.checked).map((a) => a.id);
      const engineId = seen.find((a) => radios.get(a.id)?.checked)?.id ?? null;
      if (chosenIds.length === 0) {
        saveErr.textContent = "Tick at least one account to browse.";
        saveErr.hidden = false;
        return;
      }
      saveErr.hidden = true;
      // Change management (owner opt-in): choosing which accounts are browsed is a change-controlled action.
      const cr = await requireChange(engine, "Choose the browsed accounts", "discovery-accounts-set");
      if (!cr.proceed) return;
      saveBtn.disabled = true;
      void engine
        .setDiscoveryAccounts(chosenIds, engineId, cr.change ?? undefined)
        .then((res) => {
          // QUEUED, NOT CHOSEN. Changing the browsed accounts is a gated owner action, so with dual control
          // armed the engine answers 202 and stores nothing. This branch used to be absent: the queued answer
          // was cast to a DiscoveryStatus and this handler simply refreshed, repainting the OLD selection with
          // no toast and no error, so a save the engine had accepted read as one that silently reverted.
          //
          // THE TICKS ARE PUT BACK, for the same reason its sibling one screen over puts the capture-mode
          // select back (detail-config-section.ts): a control that keeps showing the requested value while the
          // engine still holds the old one is a claim about stored state that is not true yet, and the line
          // above this chooser is already reporting the stored counts. So the chooser is re-rendered from
          // `selectedIds`, the selection this panel was mounted with, which the engine has not moved.
          //
          // A LOCAL RE-RENDER, NOT refresh(). refresh() reloads the whole Sources screen and would close the
          // chooser the operator is looking at, so the toast would be the only trace of what happened. This
          // rebuilds one panel in place, which is the same size of correction the sibling select makes. The
          // saveBtn re-enable stays for the case where chooserHost is no longer connected: the button the
          // operator clicked is then still the one on screen, and it must not be left dead.
          if (isOwnerActionQueuedResult(res)) {
            surfaceQueuedOwnerAction("Changing the browsed accounts");
            saveBtn.disabled = false;
            renderAccountChooser(ctx, chooserHost, seen, selectedIds, engineAccountId);
            return;
          }
          refresh();
        })
        .catch((e) => {
          if (isUnauthorised(e)) {
            // PAINT FIRST, THEN LEAVE: the account choice was not stored, so Save comes back.
            saveErr.textContent = SESSION_ENDED_ACTION;
            saveErr.hidden = false;
            saveBtn.disabled = false;
            return goSignedOut();
          }
          saveErr.textContent = errMsg(e);
          saveErr.hidden = false;
          saveBtn.disabled = false;
        });
    });
  }
  chooserHost.replaceChildren(
    rows,
    // Group-level doc link: the browse checkboxes and the engine's-account radios are one
    // control, so the link explaining the account tiers and the cross-account boundary sits on the group.
    h(
      "a",
      { class: "field__doc linklike", href: "https://docs.downpipes.io/sources/connect-a-source#the-three-sources-tiers", target: "_blank", rel: "noreferrer noopener" },
      "About browsing your accounts",
      svgIcon(ICON_EXTERNAL, { size: 13 }),
    ),
    saveBtn,
    saveErr,
  );
}

// renderAccountListings draws the per-account groups into body. The ENGINE's account gets
// the attach flow (ticks -> generated stanzas + the bounded deploy poll); every other
// account lists names read-only, bindings cannot cross accounts, and the screen says so.
function renderAccountListings(ctx: AccountTierCtx, body: HTMLElement): void {
  const { found } = ctx;
  const accounts = found.accounts ?? [];
  if (accounts.length === 0) {
    body.appendChild(h("p", { class: "field__hint" }, "No accounts are selected for browsing yet; choose them above."));
  }

  // "MY ACCOUNT SHOWS AS EMPTY". Two completely different faults render, three lines below, as two
  // nearly identical grey hints, and the pack holds neither:
  //
  //   a SCOPE GAP  the token is good and its read scopes do not cover what was asked, so the listings failed.
  //                The remedy is to widen the token.
  //   an EMPTY ACCOUNT  the listings all succeeded and there is genuinely nothing in the account. The remedy
  //                is the opposite: there is nothing to fix, and the customer is looking at the wrong account.
  //
  // Guessing between them from a support ticket is exactly what support cannot do today, and the two hints
  // that separate them ("Could not list: ..." and "Nothing found in this account") are Cloudflare API prose
  // and customer resource names, so neither may ride. Their EXISTENCE may, and it is the whole discriminator.
  //
  // One row per render of the whole listing, not one per account: the question is about this token's health,
  // and a per-account row would put an account count in the ring by the back door.
  const anyListingErrors = (found.accountErrors ?? []).length > 0 || accounts.some((a) => a.errors.length > 0);
  const anyResources = accounts.some((a) => a.kv.length > 0 || a.r2.length > 0 || a.d1.length > 0 || a.secrets.length > 0);
  if (anyListingErrors) recordDiscoveryConnect("listing-errors");
  else if (accounts.length > 0 && !anyResources) recordDiscoveryConnect("listing-empty");

  for (const acct of accounts) {
    const isEngine = found.engineAccountId !== null && found.engineAccountId === acct.accountId;
    const head = h(
      "div",
      { style: "display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-3)" },
      h("h4", { class: "section-title", style: "margin-bottom:0" }, acct.accountName),
      isEngine ? badge("trust", "engine's account") : badge("default", "visibility only"),
    );
    body.appendChild(head);
    if (acct.errors.length > 0) {
      body.appendChild(h("p", { class: "field__hint" }, `Could not list: ${acct.errors.join("; ")}.`));
    }
    const groups = [
      accountGroup(ctx, "KV namespaces", acct.kv.map((n) => ({ key: `kv:${acct.accountId}:${n.id}`, name: n.name, input: { type: "kv", binding: bindingFor("SRC_KV_", n.name), namespaceId: n.id } as SourceInput })), isEngine),
      accountGroup(ctx, "R2 buckets", acct.r2.map((b) => ({ key: `r2:${acct.accountId}:${b.name}`, name: b.name, input: { type: "r2", binding: bindingFor("SRC_R2_", b.name), bucketName: b.name } as SourceInput })), isEngine),
      accountGroup(ctx, "D1 databases", acct.d1.map((d) => ({ key: `d1:${acct.accountId}:${d.id}`, name: d.name, input: { type: "d1", binding: bindingFor("SRC_D1_", d.name), databaseName: d.name, databaseId: d.id } as SourceInput })), isEngine),
      accountGroup(ctx, "Secrets Store secrets", acct.secrets.map((s) => ({ key: `sec:${acct.accountId}:${s.storeId}:${s.name}`, name: s.name, input: { type: "secrets", binding: bindingFor("SRC_SEC_", s.name), storeId: s.storeId, secretName: s.name } as SourceInput })), isEngine),
    ].filter((g): g is HTMLElement => g !== null);
    if (groups.length === 0) {
      body.appendChild(h("p", { class: "field__hint" }, isEngine ? "Nothing further found in this account (or the token's scopes allow none of the four products)." : "Nothing found in this account (or the token's scopes allow none of the four products)."));
    } else {
      body.appendChild(h("div", { class: "catalogue-grid" }, ...groups));
    }
    if (!isEngine) {
      body.appendChild(
        h(
          "p",
          { class: "field__hint" },
          "Bindings cannot cross accounts: to back these up, deploy a downpipes engine in this account. If this IS the engine's account, mark it under Choose accounts.",
        ),
      );
    }
  }
}

// buildAttachPanel renders the no-terminal attach: paste a one-shot deploy token and the
// engine adds the chosen bindings to ITSELF via its safety harness (read its real
// bindings, prove the change can't drop its own, write, verify), then revoke the token.
// The wrangler deploy stays as the no-token fallback in a disclosure. The token input,
// error and result are stable nodes; the count + stanzas re-sync on every checkbox change.
function buildAttachPanel(ctx: AccountTierCtx): void {
  const { engine, found, ownerGate, chosen, stanzaHost, syncPanel } = ctx;
  const tokenInput = h("input", { "data-dp": "sources.password.token#1",
    class: "input",
    type: "password",
    autocomplete: "off",
    "aria-label": "One-shot deploy token",
    placeholder: ownerGate ? "paste a deploy token (used once, never stored)" : "an Owner attaches sources",
    ...(ownerGate ? {} : { disabled: true }),
  }) as HTMLInputElement;
  const attachBtn = ownerGate
    ? (h("button", { "data-busy-label": "Attaching", "data-dp": "sources.button.attach#1", class: "btn btn--primary btn--sm", type: "button" }, "Attach now") as HTMLButtonElement)
    : (h("button", { "data-dp": "sources.button.attach#2", class: "btn btn--primary btn--sm", type: "button" }, "Attach now") as HTMLButtonElement);
  // The shared refusal primitive: the name stays "Attach now" and the reason is the description.
  if (!ownerGate) refuseWithReason(attachBtn, gateReason("owner"));
  const attachErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const resultHost = h("div");
  const iacStanzas = h("div");
  let busy = false;

  syncPanel.fn = (): void => {
    if (busy) return;
    const n = chosen.size;
    if (ownerGate) {
      attachBtn.disabled = n === 0;
      attachBtn.textContent = n === 0 ? "Attach now" : `Attach ${n} now`;
    }
    iacStanzas.replaceChildren(
      codeBlock([...chosen.values()].map((input) => wranglerStanza(input)).join("\n\n"), { copyLabel: "Copy the bindings", label: "1. Add to engine/wrangler.toml" }),
    );
  };

  if (ownerGate) {
    attachBtn.addEventListener("click", () => {
      const inputs = [...chosen.values()]; // read AT CLICK TIME, never a stale capture
      if (inputs.length === 0) return;
      const value = tokenInput.value.trim();
      if (value === "") {
        attachErr.textContent = "Paste the deploy token first.";
        attachErr.hidden = false;
        return;
      }
      attachErr.hidden = true;
      busy = true;
      attachBtn.disabled = true;
      attachBtn.textContent = "Attaching";
      void engine
        .changeBindings(value, inputs, [])
        .then((res) => {
          if (isOwnerActionQueuedResult(res)) {
            surfaceQueuedOwnerAction("Attaching these sources");
            busy = false;
            attachBtn.disabled = false;
            attachBtn.textContent = inputs.length === 0 ? "Attach now" : `Attach ${inputs.length} now`;
            syncPanel.fn?.();
            return;
          }
          const { attached } = res.value;
          tokenInput.value = "";
          toast({ message: `${attached.length} source${attached.length === 1 ? "" : "s"} attached, verified safe. Revoke the token now.` });
          resultHost.replaceChildren(
            h(
              "p",
              { class: "field__hint" },
              "Done, and the engine verified its own bindings all survived. Keep wrangler.toml in step (a later manual deploy replaces bindings wholesale): add the stanzas when convenient:",
            ),
            codeBlock(inputs.map((input) => wranglerStanza(input)).join("\n\n"), { copyLabel: "Copy the bindings", label: "Sync into engine/wrangler.toml" }),
            waitNote(ctx, () => attached, "attach"),
          );
          busy = false;
          syncPanel.fn?.();
        })
        .catch((e) => {
          busy = false;
          if (isUnauthorised(e)) return goSignedOut();
          attachErr.textContent = errMsg(e);
          attachErr.hidden = false;
          syncPanel.fn?.();
        });
    });
  }

  stanzaHost.replaceChildren(
    h("div", { style: "display:flex;gap:var(--space-2);align-items:center;margin-top:var(--space-2)" }, tokenInput, attachBtn),
    ownerGate
      ? h(
          "p",
          { class: "field__hint", style: "margin:0" },
          h("button", { "data-dp": "sources.button.attach-token-help#1", class: "linklike", type: "button", on: { click: () => attachTokenHelp(found.engineAccountId ?? null) } }, "How do I create the deploy token?"),
          " The engine adds these to itself and verifies its own bindings all survived; then you revoke the token (it is used once and never stored here).",
        )
      : h("p", { class: "field__hint", style: "margin:0" }, `${gateReason("owner")} Attaching changes the engine's bindings.`),
    attachErr,
    resultHost,
    collapsedSection(
      "Prefer no token? Deploy it yourself",
      h(
        "div",
        { class: "stack-sm" },
        h("p", { class: "field__hint", style: "margin:0" }, "wrangler uses your own login, so this needs no token. Two pieces:"),
        iacStanzas,
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
        waitNote(ctx, () => [...chosen.values()].map((i) => i.binding), "deploy"),
      ),
    ),
  );
  syncPanel.fn();
}

// waitNote starts the bounded confirmation poll: every few seconds, re-list the
// bound bindings; when every wanted binding has appeared, celebrate and refresh.
// `want` is a getter so the IaC note follows the live selection. mode picks honest
// copy for who acts next: "deploy" (the operator must run wrangler) vs "attach"
// (the engine already updated itself; this only confirms). The manual path (run
// the deploy, come back, Refresh) keeps working regardless.
function waitNote(ctx: AccountTierCtx, want: () => string[], mode: "deploy" | "attach"): HTMLElement {
  const { engine, refresh, polls } = ctx;
  const status = h(
    "p",
    { class: "field__hint", role: "status" },
    mode === "attach"
      ? "Confirming the new bindings are live; this updates itself in a few seconds."
      : "Waiting for your deploy; this updates itself when the bindings appear.",
  );
  let attempts = 0;
  // window.setInterval returns a number in the browser, so the handle types cleanly without a
  // checker-defeating cast.
  const id = window.setInterval(() => {
    attempts++;
    if (attempts > WAIT_POLL_MAX || !status.isConnected) {
      clearInterval(id);
      if (status.isConnected) {
        status.textContent = mode === "attach"
          ? "Still confirming. Refresh this screen to re-check the bindings."
          : "Still waiting. Run the deploy, then revisit this screen (it re-checks on arrival).";
      }
      return;
    }
    void engine
      .discoverSources()
      .then((now) => {
        const wanted = want();
        const bound = new Set([...now.bound.kv, ...now.bound.r2, ...now.bound.d1, ...now.bound.secrets]);
        const live = wanted.filter((b) => bound.has(b));
        if (wanted.length > 0 && live.length === wanted.length) {
          clearInterval(id);
          toast({ message: `${live.length} binding${live.length === 1 ? "" : "s"} live; they now appear under Attached, ready to protect.` });
          refresh();
        } else if (live.length > 0) {
          status.textContent = mode === "attach"
            ? `Confirming the new bindings are live (${live.length} of ${wanted.length}).`
            : `Waiting for your deploy: ${live.length} of ${wanted.length} bindings live.`;
        }
      })
      .catch(() => {
        /* a transient poll failure is silent; the next interval retries */
      });
  }, WAIT_POLL_MS);
  polls.setWaitPoll(id);
  return status;
}
