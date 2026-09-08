// Shared leaf for the Keys and break-glass screen: the route + palette-action constants, the accessible tab
// chrome, the no-CLI one-shot token-apply affordance (the engine writes/removes its own secrets; the console
// never submits a secret), the recovery-sheet helpers, the legend / fingerprint / command presenters, and the
// browser-native blob download. These are the building blocks the four tab modules (posture, rotation, custody,
// offline recovery) reach for, so they live in this leaf and no tab module imports another tab module (which
// would form a cycle). Moved verbatim from the keys coordinator for size; behaviour, copy and markup are
// unchanged.
//
// NO-CUSTODY: no private value appears in any command shown here; identity.key is a FILE PATH placeholder,
// never a value. House style: Australian English, no em dashes, precise claims.

import { h } from "../../lib/dom.ts";
import { deliverFile, openHtmlTab } from "../../lib/file-delivery.ts";
import type { ClientDiagSurface } from "../../lib/client-diag/vocab.ts";
import { toast } from "../../components/toast.ts";
import type { ScreenAction } from "../common.ts";
import { goSignedOut, navigate, requestPostNavigationFocus } from "../../lib/nav.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { errorDetail } from "../../components/error-view.ts";
import { codeBlock, keyField, copyButton } from "../../components/code-block.ts";
import { confirmModal } from "../../components/modal.ts";
import type { StatusTone } from "../../components/status.ts";
import { recoverySheetHTML } from "../../recovery-sheet.ts";
import { attachTokenHelp } from "../sources.ts";
import { hasRole } from "../../api.ts";
import type { CeremonyResult } from "../../keygen.ts";
import type { CustodyMetadata } from "../../lib/custody.ts";

// The routes this screen owns. Each of the four sections is its OWN route, so every one of them is
// deep-linkable, back-button-navigable and reachable from a runbook, an alert e-mail or the palette.
// This is a product property, not a testing convenience: the Offline recovery commands are read during
// an incident, and "open the console, go to Keys, click the fourth tab" is a worse instruction than a
// link. The same treatment the Notifications and Access areas already carry (their sub-views are routes),
// applied to the one screen-level tabset that was still client-side only.
export const ROUTE_KEYS = "/keys";
export const ROUTE_KEYS_ROTATE = "/keys/rotate";
export const ROUTE_KEYS_CUSTODY = "/keys/custody";
export const ROUTE_KEYS_RECOVERY = "/keys/recovery";

// The section ids, and the route each one is served at. KeysTabId is the closed set the screen switches
// on, so a new section cannot be added without giving it a route.
export type KeysTabId = "posture" | "rotate" | "custody" | "recovery";

// KEYS_TAB_ROUTES is the one map between a section and its route, read by both the tablist (which
// navigates) and the screen (which resolves the matched pattern back to a section).
export const KEYS_TAB_ROUTES: Readonly<Record<KeysTabId, string>> = {
  posture: ROUTE_KEYS,
  rotate: ROUTE_KEYS_ROTATE,
  custody: ROUTE_KEYS_CUSTODY,
  recovery: ROUTE_KEYS_RECOVERY,
};

// keysTabFor resolves a matched route pattern back to the section it serves. Total: anything that is not
// one of the three sub-routes is the Posture section, which is what /keys itself serves, so an unexpected
// pattern lands on the screen's home rather than on nothing.
export function keysTabFor(pattern: string): KeysTabId {
  switch (pattern) {
    case ROUTE_KEYS_ROTATE: return "rotate";
    case ROUTE_KEYS_CUSTODY: return "custody";
    case ROUTE_KEYS_RECOVERY: return "recovery";
    default: return "posture";
  }
}

// Screen-owned palette actions.
// These are navigation targets only; the dangerous ceremony/rotation flows open
// when the operator reaches the screen and clicks the gated controls, not from
// the palette (which would bypass the role gate and the ceremony preconditions).
export const KEYS_ACTIONS: ScreenAction[] = [
  {
    id: "keys.open",
    title: "Go to Keys and break-glass",
    group: "Navigation",
    kind: "navigate",
    keywords: ["keys", "ceremony", "break-glass", "recovery", "wiring", "rotation", "custodian", "offline"],
    target: ROUTE_KEYS,
  },
  {
    id: "keys.ceremony",
    title: "Run the key ceremony",
    group: "Actions",
    kind: "navigate",
    keywords: ["ceremony", "generate keys", "break-glass", "key generation", "initial setup", "identity"],
    target: ROUTE_KEYS,
    // Owner-only mirror (shell/registry.ts requireRole pattern): the ceremony controls
    // on the screen are Owner-gated, so the palette must not offer them to other roles.
    when: ({ caller: c }) => c !== null && hasRole(c.role, "owner"),
  },
  {
    id: "keys.rotation",
    title: "Rotate the break-glass key",
    group: "Actions",
    kind: "navigate",
    keywords: ["rotate", "rotation", "new key", "break-glass", "replace key", "cycle"],
    // Lands on the Rotate section itself, now that it has a route. It used to land on ROUTE_KEYS, which
    // opened the Posture section and left the operator to find the tab: a command named for one thing
    // that arrives at another.
    target: ROUTE_KEYS_ROTATE,
    // Owner-only mirror, exactly as keys.ceremony above.
    when: ({ caller: c }) => c !== null && hasRole(c.role, "owner"),
  },
  {
    // The offline-recovery commands are what an operator reaches for during an incident, so they get a
    // command of their own that lands ON them. No role gate: the section is a reference (the exact
    // downpipe CLI invocations), it performs nothing, and every role can read it.
    id: "keys.offline-recovery",
    title: "Offline recovery commands",
    group: "Navigation",
    kind: "navigate",
    keywords: ["offline", "recovery", "incident", "commands", "cli", "downpipe", "decrypt", "restore by hand", "break-glass"],
    target: ROUTE_KEYS_RECOVERY,
  },
  {
    // Custody (the actionable M-of-N split) likewise gets a landing of its own, so "custodian" and
    // "shares" in the palette reach the section that owns them rather than the screen that contains it.
    id: "keys.custody",
    title: "Custody of the break-glass key",
    group: "Navigation",
    kind: "navigate",
    keywords: ["custody", "custodian", "m-of-n", "shares", "split", "escrow", "sign-off"],
    target: ROUTE_KEYS_CUSTODY,
  },
  // "Open recovery sheet" is already registered in shell/registry.ts as
  // "open-recovery-sheet" (target: keys.recovery-sheet). Declaring it again here
  // with a different id would produce two near-identical commands that both survive
  // the dedup (which is by id, not by target) and are both inert in the default
  // dispatch (actionRoute routes to /keys for keys.recovery-sheet, which navigates
  // rather than opening the sheet overlay). The registry entry is the single source.
];

// ---- Tab chrome (accessible: role=tablist/tab/tabpanel, roving tabindex, arrow keys) ------------

export interface KeysTab { id: KeysTabId; label: string; panel: () => HTMLElement }

// nextTabIndex maps a roving-tabindex arrow/Home/End key to the target tab index, or -1 for keys
// that do not move focus. Pulled out of the keydown handler to keep renderKeysTabs small.
function nextTabIndex(key: string, current: number, count: number): number {
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return -1;
}

// pendingTabKeyboardFocus carries one fact across the re-render an arrow-key activation causes: the
// operator moved with the keyboard, so focus belongs on the newly selected tab once it repaints. A mouse
// click leaves it false and focus is not moved, exactly as before. Same mechanism as the Notifications
// area tablist, and for the same reason (the navigation re-renders the screen, so focus cannot simply be
// set on a node that is about to be replaced).
let pendingTabKeyboardFocus = false;

// renderKeysTabs builds the tablist plus the ACTIVE section's panel. Activating a tab NAVIGATES to that
// section's route, so the URL always names what is on screen and a section can be linked to directly.
// Only the active panel is built, so a heavy section (offline recovery, custody) still costs nothing
// until it is opened. Roving tabindex + Left/Right/Home/End arrow movement.
//
// The panel cache the client-side version kept is gone with it, and nothing is lost: the panels read
// their state from the store (posture.ts getCeremony, custody.ts getCeremony) rather than holding it in
// a closure, so a re-render restores what was on screen. In-memory ceremony material survives the move
// because every keys route is in app-registry's CEREMONY_PATTERNS, so moving between sections is not a
// departure from the ceremony context and does not clear it.
export function renderKeysTabs(tabs: KeysTab[], active: KeysTabId): HTMLElement {
  const wrap = h("div");
  // Reuse the design-system underline tablist (the same .drawer-tab* pattern the detail drawer uses):
  // a real role=tablist with roving tabindex, the active tab underlined via [aria-selected="true"].
  const tablist = h("div", { class: "drawer-tablist", role: "tablist", "aria-label": "Keys sections" });
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === active));
  const PANEL_ID = `keys-tabpanel-${active}`;

  tabs.forEach((t, i) => {
    const selected = i === activeIndex;
    const btn = h(
      "button",
      {
        class: "drawer-tab",
        type: "button",
        role: "tab",
        id: `keys-tab-${t.id}`,
        "aria-controls": PANEL_ID,
        "aria-selected": selected ? "true" : "false",
        tabindex: selected ? "0" : "-1",
      },
      t.label,
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => {
      if (!selected) navigate(KEYS_TAB_ROUTES[t.id]);
    });
    tablist.appendChild(btn);
  });

  // KA-ORDER-KEYS: activating a tab NAVIGATES, and navigate() is not synchronous (it schedules a view
  // transition), so this tablist instance is still the live DOM for a beat after the FIRST arrow/Home/End
  // key fires it. `activeIndex` above is frozen at the value this render was built with, so a SECOND
  // keydown landing on this SAME (stale, not-yet-replaced) tablist -- ordinary OS key-repeat when an
  // operator holds the key, or simply two presses inside one render cycle -- recomputes `next` from that
  // same frozen index and re-navigates to the SAME destination: not a second advance, a no-op repeat of
  // the first. `navigated` closes that window: once one key has moved this tablist, every further keydown
  // on this instance is ignored: the fresh tablist the navigation is about to mount takes over from there,
  // with its own live activeIndex. This fixes a real zero-gap key-repeat defect (a post-navigation focus
  // race under a live engine).
  let navigated = false;
  tablist.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (navigated) return;
    const next = nextTabIndex(ev.key, activeIndex, tabs.length);
    if (next < 0) return;
    ev.preventDefault();
    navigated = true;
    pendingTabKeyboardFocus = true;
    // next is bounded by modular arithmetic on tabs.length, so the index is always valid.
    navigate(KEYS_TAB_ROUTES[tabs[next]!.id]);
  });

  const panelHost = h("div", {
    class: "drawer-tabpanel",
    id: PANEL_ID,
    role: "tabpanel",
    tabindex: "0",
    "aria-labelledby": `keys-tab-${active}`,
    style: "margin-top:var(--space-4)",
  });
  panelHost.appendChild(tabs[activeIndex]!.panel());

  wrap.appendChild(tablist);
  wrap.appendChild(panelHost);

  if (pendingTabKeyboardFocus) {
    pendingTabKeyboardFocus = false;
    // Declared to the shell rather than scheduled here. A queueMicrotask restore ran BEFORE the shell had
    // mounted this wrap under a view transition (so focus() hit a detached node and did nothing) and, when
    // it did land, the shell's own post-navigation focus move to <main> overwrote it a moment later. The
    // shell reads this after the swap and honours it instead of <main>. See lib/nav.ts.
    requestPostNavigationFocus(() => wrap.querySelector<HTMLButtonElement>(`#keys-tab-${active}`));
  }

  return wrap;
}

// Shared no-CLI apply (a one-shot scoped token; the engine writes/removes its own secrets).

// confirmApply guards an irreversible apply (e.g. the posture switch) behind a modal so it can never fire
// on a stray click; confirmModal resolves true only on an explicit confirm.
//
// It CONFIRMS and nothing else. It used to take the apply as well and fire it with `void run()`, which read
// as "confirm, then run" and behaved as "return whether it was confirmed, and lose the run": nothing could
// await the apply, and the apply owns the button. Splitting them puts the busy control and the call that
// resolves it in one frame, which is the only arrangement in which either can be checked.
async function confirmApply(confirm: { title: string; body: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return await confirmModal({
    title: confirm.title,
    body: confirm.body,
    confirmLabel: confirm.confirmLabel,
    variant: confirm.danger === true ? "danger" : "primary",
  });
}

// renderTokenApply is the in-console apply affordance used by rotation and the posture switch (and
// the re-key wiring): a scoped "Edit Cloudflare Workers" token input + a "How do I create the token?"
// helper + an apply button that hands the token to the engine, which performs the privileged op and
// the token is never stored. No customer CLI. An optional confirm-to-act guards an irreversible apply
// so it can never fire on a stray click. onApplied runs after a successful apply (e.g. a status poll).
//
// tokenPurpose is REQUIRED and names the privileged operation in the token input's accessible name:
// a re-key renders two instances of this affordance at once, and two password fields with byte-identical accessible
// names are indistinguishable to a screen reader, a password manager, and a harness locator alike.
// The data-dp identity stays shared deliberately: it names this ONE source call site, exactly as a
// table row's hook names its column, and the census counts source sites, not mounted instances.
export function renderTokenApply(opts: {
  applyLabel: string;
  tokenPurpose: string;
  busyLabel: string;
  doneLabel: string;
  apply: (token: string) => Promise<void>;
  onApplied?: () => void;
  confirm?: { title: string; body: string; confirmLabel: string; danger?: boolean };
  engineAccountId?: string | null;
}): HTMLElement {
  const wrap = h("div", { class: "stack-sm", style: "margin-top:var(--space-3)" });
  const tokenInput = h("input", { "data-dp": "keys.password.token", class: "input", type: "password", autocomplete: "off", "aria-label": `One-shot Cloudflare deploy token to ${opts.tokenPurpose}`, placeholder: "paste a deploy token (used once, never stored)" }) as HTMLInputElement;
  const applyBtn = h("button", { "data-dp": "keys.button.apply", class: "btn btn--primary", type: "button" }, opts.applyLabel) as HTMLButtonElement;
  const err = h("p", { class: "field__error", role: "alert", hidden: true });
  const info = h("p", { class: "field__hint", role: "status", "aria-live": "polite", hidden: true });

  const run = async (): Promise<void> => {
    const token = tokenInput.value.trim();
    // The click handler below disables this button BEFORE run() is reached (so a double-click cannot open
    // two confirm modals), and run() owns it from then on. This early return is inside that ownership, so
    // it has to give the button back: without it, pressing Apply with the field empty (and confirming, on
    // the guarded variants) left the one control on this step dead until the tab was reloaded.
    if (token === "") {
      err.textContent = "Paste the deploy token first.";
      err.hidden = false;
      applyBtn.disabled = false;
      applyBtn.textContent = opts.applyLabel;
      return;
    }
    err.hidden = true;
    applyBtn.disabled = true; applyBtn.textContent = opts.busyLabel;
    info.hidden = false; info.textContent = "Working. The engine performs this with the one-shot token; nothing is stored.";
    try {
      await opts.apply(token);
      tokenInput.value = ""; tokenInput.disabled = true;
      applyBtn.textContent = opts.doneLabel;
      info.textContent = "Done. Revoke the token now on the Cloudflare API Tokens page.";
      opts.onApplied?.();
    } catch (e) {
      if (isUnauthorised(e)) {
        // PAINT FIRST, THEN LEAVE: the apply did not happen, so the button and the "Working." line
        // both go back rather than sitting on a ceremony step that has stopped.
        info.hidden = true;
        applyBtn.disabled = false;
        applyBtn.textContent = opts.applyLabel;
        return goSignedOut();
      }
      // errorDetail runs the SAME classifyError pipeline blockError uses, so a 403/429/network fault
      // reads as reviewed customer copy here too, never the raw "<verb>: <status>" transport throw.
      err.textContent = errorDetail(e);
      err.hidden = false; info.hidden = true;
      applyBtn.disabled = false; applyBtn.textContent = opts.applyLabel;
    }
  };

  applyBtn.addEventListener("click", () => {
    // Disable up-front so a rapid double-click cannot open two overlapping confirm
    // modals (or start two run() calls). run() owns the disabled state once it begins;
    // on the confirm path we re-enable only when the operator cancels.
    applyBtn.disabled = true;
    if (opts.confirm) {
      void confirmApply(opts.confirm).then((okp) => {
        if (!okp) {
          applyBtn.disabled = false;
          return;
        }
        void run();
      });
      return;
    }
    void run();
  });

  wrap.appendChild(h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, tokenInput, applyBtn));
  // THE CEREMONY, named before the button rather than discovered after it. Every apply this control drives
  // is a step-up gated write on the engine (key install, add-operational, break-glass rotation, the
  // break-glass-only posture switch), so the browser opens a passkey prompt on the apply. The sentence lives
  // here rather than in each of the four host screens because it is the same claim for all of them and one
  // copy cannot drift out of step with the others.
  wrap.appendChild(
    h("p", { class: "field__hint measure" },
      "You may be asked to confirm with your own passkey before your engine is changed. If you dismiss that prompt, or it fails, nothing is written and you can apply again from here.",
    ),
  );
  wrap.appendChild(
    h("p", { class: "field__hint" },
      h("button", { "data-dp": "keys.button.attach-token-help", class: "linklike", type: "button", on: { click: () => attachTokenHelp(opts.engineAccountId ?? null) } }, "How do I create the token?"),
      " Use the “Edit Cloudflare Workers” template, scoped to the engine's own account. It is used once, then revoke it.",
    ),
  );
  wrap.appendChild(err);
  wrap.appendChild(info);
  return wrap;
}

// ---- small helpers ----------------------------------------------------------

// A legend item: plain text, or a file with a per-file download button reading from the
// in-memory ceremony result (the content closure keeps the value out of the DOM; the
// browser-native blob download is the same no-custody path the auto-download uses).
export interface LegendItem {
  label: string;
  download?: { name: string; content: () => string };
}

export function legendCol(title: string, items: Array<string | LegendItem>, tone: StatusTone): HTMLElement {
  const col = h("div", { class: `legend-col legend-col--${tone}` });
  col.appendChild(h("h4", { class: "legend-col__title" }, title));
  const ul = h("ul", { class: "legend-col__list" });
  for (const item of items) {
    if (typeof item === "string") {
      ul.appendChild(h("li", item));
      continue;
    }
    const li = h("li", item.label);
    const dl = item.download;
    if (dl) {
      li.appendChild(document.createTextNode(" "));
      li.appendChild(
        h(
          "button",
          { "data-dp": "keys.button.download-text", class: "linklike", type: "button", "aria-label": `Download ${dl.name}`, on: { click: () => downloadText(dl.name, dl.content(), "text/plain", "key-ceremony") } },
          "Download",
        ),
      );
    }
    ul.appendChild(li);
  }
  col.appendChild(ul);
  return col;
}

export function fpRow(label: string, fingerprint: string): HTMLElement {
  const row = h(
    "div",
    { class: "fp-row" },
    h("span", { class: "fp-row__label field__hint" }, label),
  );
  // Focusable: the fingerprint clips and scrolls horizontally; keyboard users must be
  // able to scroll the full string into view to verify it (WCAG 2.1.1).
  const fpEl = h("code", { class: "mono fp-row__value", tabindex: "0", role: "region", "aria-label": `${label} fingerprint` });
  fpEl.textContent = fingerprint; // server-computed but a public hex string; textContent is correct
  row.appendChild(fpEl);
  row.appendChild(copyButton(`Copy ${label} fingerprint`, () => fingerprint));
  return row;
}

export function commandWithValue(command: string, value: string): HTMLElement {
  const wrap = h("div", { class: "command-with-value" });
  wrap.appendChild(codeBlock(command));
  wrap.appendChild(keyField({ label: `${command.replace("npx wrangler secret put ", "")} value`, value }));
  return wrap;
}

// sheetParams builds the recovery-sheet metadata. The optional custody argument carries the
// chosen offline custody scheme + custodian sign-off (public metadata only; never a key or
// share value). It is included only when a scheme has been chosen, so a sheet produced
// before the custody step simply omits the section (exactOptionalPropertyTypes).
export function sheetParams(
  result: CeremonyResult,
  custody?: CustodyMetadata,
): { downpipeAccount: string; createdAt: string; posture: "two-recipient" | "break-glass-only"; custody?: CustodyMetadata } {
  const includeCustody = custody !== undefined && custody.scheme !== "undecided";
  return {
    downpipeAccount: location.host,
    createdAt: new Date().toISOString(),
    posture: result.operational ? "two-recipient" : "break-glass-only",
    ...(includeCustody ? { custody } : {}),
  };
}

// openRecoverySheetWith opens the self-contained, public-only recovery sheet in a new tab, through the
// guarded blob-tab primitive (lib/file-delivery.ts). The sheet document gets its own opaque origin, which
// keeps it independent of the console's Content-Security-Policy, and its print button uses addEventListener
// rather than an inline onclick, so no unsafe-hashes exemption is needed. The sheet carries only PUBLIC
// fingerprints; no private key material is placed into the HTML (see the NO-CUSTODY assertion in
// recoverySheetHTML). The optional custody argument carries the chosen scheme and custodian sign-off (public
// metadata only) so the printed sheet records it.
//
// A browser that refuses the blob tab used to fail silently. It now tells the operator and reports a
// closed-class capability fault into the support pack, and returns false so a caller can react.
export function openRecoverySheetWith(result: CeremonyResult, custody?: CustodyMetadata): boolean {
  const opened = openHtmlTab(recoverySheetHTML(result, sheetParams(result, custody)), "recovery-sheet");
  if (!opened) {
    toast({ tone: "warn", message: "Your browser would not open the recovery sheet. Download recovery-sheet.txt instead, or allow this site to open new tabs." });
  }
  return opened;
}

// downloadText delivers one in-memory file through the guarded primitive. It returns whether the browser
// accepted the delivery, and on a refusal it says so: a recovery file that never arrived is the one failure
// the operator must not discover months later, when they need it. Every keys-screen download (the
// rotated identity.key, the custody ciphertext and shares, the legend files) goes through here, so the warning
// and the fault record are the same wherever the refusal happens.
//
// The SURFACE comes from the caller, because this one helper serves two ceremonies with very different stakes:
// a refused identity.key in the FIRST ceremony leaves the customer with no key at all, while a refused
// identity.key during a ROTATION leaves the old key still working. The keys ROUTE cannot tell them apart, so
// the route alone would have given support a row it could not act on. The file NAME goes into the toast and
// nowhere else: the closed record has no field for it.
export function downloadText(name: string, content: string, type: string, surface: ClientDiagSurface): boolean {
  const delivered = deliverFile(name, content, type, surface);
  if (!delivered) {
    toast({ tone: "warn", message: `Your browser did not save ${name}. Check its download settings, then use the download control again.` });
  }
  return delivered;
}
