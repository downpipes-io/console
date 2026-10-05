// Focus Flow questions: Welcome (the plan is the promise) and Connect (the read-only token).

import { confirmModal } from "../../../components/modal.ts";
import { h, svgIcon } from "../../../lib/dom.ts";
import { ICON_ALERT, ICON_HOURGLASS, ICON_INFO, ICON_SHIELD_CHECK, ICON_X_CIRCLE } from "../../../lib/icons.ts";
import { accessSentence, type EngineProbe, probeEngine } from "../../../lib/setup-flow/engine-probe.ts";
import {
  chooseAccounts, leaveAfterPaint, MINIMAL_TOKEN_PERMISSIONS, readAccountChoice, removeToken, SETUP_TIME_ESTIMATE, setupModel, startSetup, TOKEN_SCOPES, type TokenScope, verifyToken,
} from "../../../lib/setup-flow/index.ts";
import { stepDone } from "./flow.ts";
import { CF_API_TOKENS, checkRow, externalLink, field, line, message, openSheet, textButton, tileGroup } from "./kit.ts";
import { accountName, renderPlainPlan } from "./plan.ts";
import type { QCtx, QView } from "./types.ts";


// ---- Welcome ----------------------------------------------------------------------------------------------------

// The engine check's answer for this page load (lib/setup-flow/engine-probe.ts), kept so a rerender shows it.
let probe: EngineProbe | null = null;

// engineLine says what the engine check found, or that it is still looking.
function engineLine(c: QCtx): HTMLElement {
  const host = h("div", { class: "fb-engine", "aria-live": "polite" });
  const paint = (p: EngineProbe | null): void => {
    if (p === null) {
      host.replaceChildren(line(ICON_HOURGLASS, "Checking your engine.", "fb-line--muted"));
      return;
    }
    const retry = textButton("Check again", () => {
      probe = null;
      paint(null);
      void probeEngine(true).then((r) => { probe = r; c.rerender(); void setupModel().refresh(); });
    });
    switch (p.state) {
      case "ok": {
        const signIn = p.verdict !== null ? accessSentence(p.verdict) : null;
        host.replaceChildren(line(ICON_SHIELD_CHECK, `Your engine answers. Version ${p.version}.`, "fb-line--trust"), ...(signIn !== null ? [line(ICON_ALERT, signIn, "fb-line--warn")] : []));
        return;
      }
      case "engine-not-ok":
        host.replaceChildren(errorLine("Your engine answers but reports that it is not healthy. Check the engine's logs, then check again.", retry));
        return;
      case "health-ok-status-failing":
        host.replaceChildren(errorLine("Your engine answers, but not to this signed-in browser. Check that your Cloudflare Access policy admits you and that the engine's CONSOLE_ORIGIN names this console.", retry));
        return;
      case "unreachable":
        host.replaceChildren(errorLine("The console could not reach your engine. Check that the engine is deployed, then check again.", retry));
        return;
      case "unauthorised":
        host.replaceChildren(errorLine("Your session ended. Sign in again."));
        leaveAfterPaint();
        return;
    }
  };
  paint(probe);
  if (probe === null) {
    void probeEngine().then((r) => {
      probe = r;
      if (host.isConnected) {
        paint(r);
        c.refresh();
      }
    });
  }
  return host;
}

function errorLine(text: string, extra?: Node): HTMLElement {
  return h("p", { class: "fb-msg fb-msg--error", role: "alert" }, svgIcon(ICON_X_CIRCLE, { size: 16 }), h("span", { class: "fb-msg__text" }, text), extra ?? null);
}

export function welcome(c: QCtx): QView {
  const err = c.s.facts.readError;
  return {
    eyebrow: "Set up downpipes",
    title: "Set up your first backup",
    body: [
      engineLine(c),
      h("h2", { class: "fb-h2" }, "Make these in the Cloudflare dashboard"),
      h(
        "ol",
        { class: "fb-creds" },
        h("li", "A read-only API token."),
        h("li", "An access key for your backup bucket."),
        h("li", "A deploy token. You use it once."),
      ),
      line(ICON_HOURGLASS, SETUP_TIME_ESTIMATE),
      line(ICON_INFO, "Your Cloudflare account needs the Workers Paid plan."),
      // On a phone the plan column is off the page: the same plain road shows here (hidden at desktop).
      h("div", { class: "fb-welcome-plan" }, renderPlainPlan(false)),
      err !== null && probe?.state === "ok" ? errorLine(`${err} Check that your engine is deployed. Then reload.`) : null,
    ].filter((n): n is HTMLElement => n !== null),
    primary: {
      label: "Start",
      reason: () => (probe === null ? "Start waits for the engine check." : probe.state !== "ok" || c.s.facts.readError !== null ? "Start waits for your engine." : null),
      run: () => {
        startSetup();
        c.next();
      },
    },
  };
}

// ---- Connect ----------------------------------------------------------------------------------------------------

export function connect(c: QCtx): QView {
  const m = setupModel();
  const s = c.s;
  const done = stepDone(s, "connect");
  const acct = accountName(s);
  const alert = message("error");
  const warn = message("warn");
  const token = field({ id: "setup-cf-token", label: "Read-only token", type: "password", hint: "Your engine keeps this token until you remove it.", doc: { href: "https://docs.downpipes.io/sources/connect-a-source", anchor: "the-two-tokens" } });
  // Each tile states its trade-off, both ways, and how to make that token, on its face.
  const lines: Record<TokenScope, string[]> = {
    "read-all": ["Use the Read all resources template.", "Reads every resource and setting. Configuration backup works too."],
    minimal: [`Add ${MINIMAL_TOKEN_PERMISSIONS.map((p) => p.replace(/ : Read$/, "")).join(", ")}, each as Read.`, "Configuration, Workers and media backup stay off."],
  };
  // The engine refuses a token with no expiry, or one more than 90 days away (engine src/admin/cf-api.ts
  // discoveryTokenExpiryVerdict, DISCOVERY_TOKEN_MAX_DAYS), and the dashboard's default is no expiry.
  const scopes = tileGroup<TokenScope>({
    name: "scope",
    legend: "Make the token with",
    choices: TOKEN_SCOPES.map((t) => ({ id: t.id, label: t.label, lines: lines[t.id] })),
    selected: s.draft.tokenScope,
    columns: 2,
    onChange: (id) => m.update({ tokenScope: id }),
  });
  return {
    title: "Paste your read-only Cloudflare token",
    lede: [done ? `Your engine holds a token for ${acct}. Paste a new one to replace it.` : "Your engine uses it to list what you can protect. It cannot change anything."],
    body: [
      scopes.el,
      h("p", { class: "fb-row" }, "Set an expiry of 90 days or less. ", externalLink("Open API Tokens", CF_API_TOKENS)),
      token.el,
      alert.el,
      warn.el,
      done ? h("p", { class: "fb-row" }, textButton("Choose accounts", () => accountSheet(c, false)), textButton("Remove token", () => void remove(c, alert))) : null,
    ].filter((n): n is HTMLElement => n !== null),
    focus: () => token.input,
    primary: {
      label: "Verify token",
      busyLabel: "Verifying",
      busyText: "Your engine is checking the token with Cloudflare.",
      run: async () => {
        token.setError(null);
        alert.set(null);
        warn.set(null);
        if (token.input.value.trim() === "") {
          token.setError("Paste the token first.");
          token.input.focus();
          return;
        }
        c.setBusy(true);
        const r = await verifyToken(token.input.value);
        token.input.value = "";
        c.setBusy(false);
        if (!r.ok) {
          if (r.error.kind === "zero-accounts") {
            warn.set("Cloudflare accepted the token, but it sees no accounts. Add your account under Account Resources, then paste the new token.");
          } else if (r.error.field === "token") {
            token.setError(r.error.kind === "refused" ? refusedText(r.error.message) : r.error.message);
            token.input.focus();
          } else alert.set(r.error.message);
          return;
        }
        // A token that sees more than one account: choose which ones the list shows, and which is the engine's.
        if (r.data.accountsSeen > 1) return accountSheet(c, true);
        c.next();
      },
    },
    secondary: done ? [textButton("Keep this token", () => c.next())] : [],
  };
}

// refusedText leads with what happened in plain words; the vendor's code, when there is one, comes last. Only a
// refusal by Cloudflare itself (an authentication error with its code) is reworded. The engine's own reasons
// (no expiry, an expiry too far away, a token that sees no account) name their remedy, and pasting the same
// token again would not help, so they are shown as the engine wrote them.
function refusedText(msg: string): string {
  const sentence = `${msg.charAt(0).toUpperCase()}${msg.slice(1).replace(/\.?$/, ".")}`;
  if (/expir/i.test(msg)) return `${sentence} Nothing was stored.`;
  if (!/authentication/i.test(msg)) return `${sentence} Paste the whole token again.`;
  const code = /code (\d+)/i.exec(msg)?.[1];
  return `Cloudflare refused this token. Nothing was stored. Paste the whole token again.${code ? ` Cloudflare code ${code}.` : ""}`;
}

async function remove(c: QCtx, alert: { set: (m: string | null) => void }): Promise<void> {
  const ok = await confirmModal({
    title: "Remove the read-only token?",
    body: "Your engine stops listing your resources. Sources you already attached and downpipes you made are not changed. You can paste a new token at any time.",
    confirmLabel: "Remove",
    variant: "danger",
  });
  if (!ok) return;
  const r = await removeToken();
  if (!r.ok) {
    if (r.error.kind !== "cancelled") alert.set(r.error.message);
    return;
  }
  c.rerender();
}

// accountSheet is the account chooser (sources/account.ts renderAccountChooser) in one sheet: which accounts
// the list shows, and which one your engine runs in. After a first verify, saving it moves on.
function accountSheet(c: QCtx, thenNext: boolean): void {
  const err = message("error");
  const host = h("div", { class: "fb-extra" }, h("p", { class: "fb-note" }, "Reading the accounts your token sees."));
  const save = h("button", { "data-dp": "setup.button.save", class: "btn btn--primary", type: "button" }, "Save accounts") as HTMLButtonElement;
  const sheet = openSheet({ title: "Which accounts should downpipes list?", body: [host, err.el], actions: [save], opener: document.activeElement as HTMLElement | null });
  let read: { seen: Array<{ id: string; name: string }>; selected: Set<string>; engine: () => string | null } | null = null;
  void readAccountChoice().then((r) => {
    if (!r.ok) {
      host.replaceChildren();
      err.set(r.error.message);
      return;
    }
    const selected = new Set(r.data.selected.length > 0 ? r.data.selected : r.data.seen.map((a) => a.id));
    const browse = h("fieldset", { class: "fb-tiles" }, h("legend", { class: "fb-legend" }, "List resources from"), ...r.data.seen.map((a) => checkRow({ label: a.name, secondary: a.id, checked: selected.has(a.id), onChange: (v) => { if (v) selected.add(a.id); else selected.delete(a.id); } }).el));
    const engineTiles = tileGroup<string>({
      name: "engine-account",
      legend: "Your engine runs in",
      choices: r.data.seen.map((a) => ({ id: a.id, label: a.name, lines: ["Bindings and keys attach here."] })),
      selected: r.data.engineAccountId,
      numberKeys: false,
    });
    host.replaceChildren(browse, engineTiles.el);
    read = { seen: r.data.seen, selected, engine: () => engineTiles.value() };
  });
  save.addEventListener("click", () => {
    if (read === null) return;
    err.set(null);
    void chooseAccounts([...read.selected], read.engine()).then((r) => {
      if (!r.ok) {
        if (r.error.kind !== "cancelled") err.set(r.error.message);
        return;
      }
      sheet.close();
      if (thenNext) c.next();
      else c.rerender();
    });
  });
}
