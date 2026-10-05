// Focus Flow questions for step 5, Apply: one deploy token installs the keys and attaches the picked binding
// sources (a live checklist of the real stages, with elapsed time, and no spinner); the no-token route (own
// wrangler or CI) is a peer tile; the revoke instruction is a question of its own and, when deferred, stays
// pinned on every later view until the user confirms it.

import { h, svgIcon } from "../../../lib/dom.ts";
import { ICON_ALERT, ICON_CHECK, ICON_COPY, ICON_SHIELD_CHECK, ICON_X_CIRCLE } from "../../../lib/icons.ts";
import { enter } from "../../../lib/motion.ts";
import {
  APPLY_ROUTES, type ApplyRoute, type ApplyStage, type ApplyStageState,applyWithDeployToken, bindingsToAttach, DEPLOY_TOKEN_TEMPLATE, markDeployTokenRevoked, pickedResources,
  refreshDiscovery, selfDeployPlan, setupModel, 
} from "../../../lib/setup-flow/index.ts";
import { stepDone } from "./flow.ts";
import { CF_API_TOKENS, checkRow, externalLink, field, line, message, textButton, tileGroup } from "./kit.ts";
import { setLiveInstall } from "./live.ts";
import type { QCtx, QView } from "./types.ts";

function routeTiles(c: QCtx, selected: ApplyRoute): HTMLElement {
  const m = setupModel();
  const t = tileGroup<ApplyRoute>({
    name: "route",
    legend: "How to apply",
    choices: APPLY_ROUTES.map((r) => ({ id: r.id, label: r.id === "token" ? "Deploy token" : "My own wrangler or CI", lines: [r.id === "token" ? "The console installs with it." : "You deploy the settings yourself."] })),
    selected,
    columns: 2,
    onChange: (id) => {
      m.update({ applyRoute: id });
      c.answer("apply");
      c.go(id === "token" ? "apply" : "manual", { replace: true });
    },
  });
  return t.el;
}

// ---- Deploy token and the live checklist ------------------------------------------------------------------------

// applyLede says what the token does on this press: install the keys, attach the picks, or both.
function applyLede(keysIn: boolean, picks: number): string {
  const what = `${picks} ${picks === 1 ? "pick" : "picks"}`;
  if (keysIn) return picks > 0 ? `Your keys are installed. It attaches your ${what}.` : "Your keys are installed.";
  return picks > 0 ? `It installs your keys and attaches your ${what}.` : "It installs your keys.";
}

type Row = { el: HTMLElement; glyph: HTMLElement; state: HTMLElement; t0: number; status: "wait" | "run" | "done" | "skip" | "fail" };

export function apply(c: QCtx): QView {
  const s = c.s;
  const d = s.draft;
  const picks = pickedResources(s);
  const attach = bindingsToAttach();
  // The keys are in (or were sent and accepted) after a first press that installed them and then stopped at the
  // attach: every line on this view then says so, and "Paste another token" only attaches.
  const keysIn = s.facts.keysReady || d.keysSent;
  const types = new Set<string>(attach.map((a) => a.type));
  const token = field({ id: "setup-deploy-token", label: "Deploy token", type: "password", doc: { href: "https://docs.downpipes.io/operations/cloudflare-token-scopes", anchor: "the-token-permissions" } });
  const alert = message("error");
  const warn = message("warn");
  const adds = [types.has("d1") ? "D1 Edit" : null, types.has("secrets") ? "Secrets Store Edit" : null].filter((x): x is string => x !== null);
  const perm = `Use the ${DEPLOY_TOKEN_TEMPLATE} template${adds.length > 0 ? `, and add ${adds.join(" and ")}` : ""}. Limit it to this account. Set the shortest expiry.`;
  const formPart = h(
    "div",
    { class: "fb-applyform" },
    routeTiles(c, "token"),
    h("p", { class: "fb-row" }, perm, " ", externalLink("Open API Tokens", CF_API_TOKENS)),
    !keysIn && d.posture === "operational" ? line(ICON_ALERT, "This also installs your operational key in your engine. It can decrypt your backups.", "fb-line--warn") : null,
    token.el,
    h("p", { class: "fb-field__hint" }, "A passkey check may follow."),
  );
  const names = attach.map((a) => picks.find((r) => r.binding === a.binding)?.name ?? a.binding);
  const labels: Record<Exclude<ApplyStage, "done">, string> = {
    "install-keys": "Install your keys",
    "confirm-keys": "Engine loads the keys",
    "attach-sources": names.length > 0 ? `Attach ${names.join(" and ")}` : "Attach sources",
    "confirm-sources": "Bindings go live",
  };
  const rows = new Map<Exclude<ApplyStage, "done">, Row>();
  const list = h("ol", { class: "fb-checklist", "aria-live": "polite" });
  for (const k of Object.keys(labels) as Array<Exclude<ApplyStage, "done">>) {
    const glyph = h("span", { class: "fb-check-glyph", "aria-hidden": "true" }, h("span", { class: "fb-dot fb-dot--unset" }));
    const state = h("span", { class: "fb-checklist__state" }, "Waits");
    const el = h("li", { class: "fb-checklist__row fb-checklist__row--wait" }, glyph, h("span", { class: "fb-checklist__label" }, labels[k]), state);
    rows.set(k, { el, glyph, state, t0: 0, status: "wait" });
    list.appendChild(el);
  }
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  let ticker: ReturnType<typeof setInterval> | null = null;
  const setRow = (k: Exclude<ApplyStage, "done">, st: Row["status"], text?: string): void => {
    const r = rows.get(k)!;
    if (st === "run" && r.status !== "run") r.t0 = Date.now();
    r.status = st;
    r.el.className = `fb-checklist__row fb-checklist__row--${st}`;
    r.glyph.replaceChildren(st === "done" ? svgIcon(ICON_CHECK, { size: 14 }) : st === "fail" ? svgIcon(ICON_X_CIRCLE, { size: 14 }) : h("span", { class: `fb-dot fb-dot--${st === "run" ? "busy" : "unset"}` }));
    enter(r.glyph, { from: "fade", duration: "--dur-1" });
    r.state.textContent = text ?? (st === "done" ? `Done, ${secs(Date.now() - r.t0)}` : st === "run" ? "In progress" : st === "skip" ? "Not needed" : st === "fail" ? "Failed" : "Waits");
  };
  const progressPart = h("div", { class: "fb-progresspart" }, list, line(ICON_SHIELD_CHECK, "identity.key stays with you. It never leaves this device.", "fb-line--trust"), warn.el, alert.el);
  const answer = h("div", { class: "fb-swap" }, formPart);
  let inProgress = false;
  const live: Record<Exclude<ApplyStage, "done">, string> = { "install-keys": "Installing keys", "confirm-keys": "Waiting for the engine", "attach-sources": `Attaching ${names.length} sources`, "confirm-sources": "Waiting for the bindings" };

  const view: QView = {
    title: "Paste one deploy token",
    lede: [applyLede(keysIn, attach.length)],
    body: [answer],
    focus: () => token.input,
    primary: {
      label: "Install and attach",
      busyLabel: "Installing and attaching",
      reason: () => (inProgress ? "Keep this page open." : null),
      run: async () => {
        if (stepDone(setupModel().get(), "apply")) {
          c.next();
          return;
        }
        token.setError(null);
        alert.set(null);
        warn.set(null);
        if (token.input.value.trim() === "") {
          token.setError("Paste the deploy token first.");
          token.input.focus();
          return;
        }
        const value = token.input.value;
        token.input.value = "";
        inProgress = true;
        c.setBusy(true);
        answer.replaceChildren(progressPart);
        enter(progressPart, { from: "below", distance: 8, duration: "--dur-2" });
        const h1 = document.querySelector<HTMLElement>(".fb-h1");
        if (h1) {
          h1.textContent = "Applying your setup";
          h1.focus();
        }
        const lede = document.querySelector<HTMLElement>(".fb-lede");
        if (lede) lede.textContent = "Your engine uses the token for these steps only.";
        ticker = setInterval(() => {
          for (const r of rows.values()) if (r.status === "run") r.state.textContent = `In progress, ${Math.round((Date.now() - r.t0) / 1000)} s`;
        }, 1000);
        let r: Awaited<ReturnType<typeof applyWithDeployToken>> | null = null;
        try {
          r = await applyWithDeployToken(value, (stage: ApplyStage, state: ApplyStageState, detail) => {
            if (stage === "done") return;
            setRow(stage, state === "start" ? "run" : state === "done" ? "done" : "skip", state === "start" && detail && detail.total > 0 && stage === "confirm-sources" ? `In progress, ${detail.done} of ${detail.total}` : undefined);
            setLiveInstall(state === "start" ? live[stage] : null);
          });
        } catch (e) {
          r = { ok: false, error: { kind: "refused", message: e instanceof Error ? e.message : "The apply did not complete. Try again." } };
        } finally {
          // Every path releases the primary and the live plan line before anything else happens.
          if (ticker !== null) clearInterval(ticker);
          setLiveInstall(null);
          inProgress = false;
          c.setBusy(false);
          if (h1) h1.textContent = r?.ok ? "Your setup is applied" : "The apply did not finish";
        }
        if (!r.ok) {
          for (const [k, row] of rows) if (row.status === "run") setRow(k, "fail");
          if (r.error.kind === "timeout") {
            // The engine took the change and has not reported it yet: check again without a new token. When
            // the keys are in and a binding still waits, the form comes back; the install is then skipped.
            warn.set(r.error.message, textButton("Check again", () => {
              void refreshDiscovery().then(() => {
                if (stepDone(setupModel().get(), "apply")) c.next();
                else c.rerender();
              });
            }));
          }
          else alert.set(r.error.message, textButton("Paste another token", () => c.rerender()));
          return;
        }
        // The next question opens as soon as the engine confirms. No transient button is left under the
        // pointer, and the Revoke question asks for a tick, so no stray click can answer it.
        c.answer("apply");
        c.next();
      },
    },
    dispose: () => {
      if (ticker !== null) clearInterval(ticker);
      setLiveInstall(null);
    },
  };
  if (stepDone(s, "apply")) {
    view.lede = ["Your keys are installed and your picks are live."];
    view.body = [line(ICON_CHECK, "Nothing is left to apply.", "fb-line--muted")];
    view.primary = { label: "Continue", run: () => c.next() };
    delete view.focus;
  }
  return view;
}

// ---- Own wrangler or CI -----------------------------------------------------------------------------------------

function copyBtn(text: string, label: string): HTMLButtonElement {
  return h("button", { "data-dp": "setup.button.copy-btn", class: "fb-textbtn", type: "button", "aria-label": label, on: { click: () => { if (navigator.clipboard) void navigator.clipboard.writeText(text); } } }, svgIcon(ICON_COPY, { size: 14 }), "Copy") as HTMLButtonElement;
}

export function manual(c: QCtx): QView {
  const p = selfDeployPlan();
  const alert = message("warn");
  const secrets = h(
    "ul",
    { class: "fb-secrets" },
    ...p.secrets.map((x) => h("li", { class: "fb-secrets__row" }, h("code", x.command), x.value !== null ? copyBtn(x.value, `Copy the value for ${x.command.split(" ").pop() ?? ""}`) : h("span", { class: "fb-field__hint" }, "Make your keys first."))),
  );
  return {
    title: "Apply the settings yourself",
    lede: ["Add these secrets and bindings with wrangler or your CI. Then deploy."],
    body: [
      routeTiles(c, "self-deploy"),
      h("h2", { class: "fb-h2" }, "Secrets"),
      secrets,
      p.stanzas !== "" ? h("div", { class: "fb-code" }, h("h2", { class: "fb-h2" }, "Bindings for wrangler.toml", copyBtn(p.stanzas, "Copy the bindings")), h("pre", p.stanzas)) : null,
      h("div", { class: "fb-code" }, h("h2", { class: "fb-h2" }, "Deploy"), h("pre", p.deployCommand)),
      h("p", { class: "fb-note" }, "The console then checks the keys and the bindings. It needs no token."),
      alert.el,
    ].filter((n): n is HTMLElement => n !== null),
    primary: {
      label: "Check my engine",
      busyLabel: "Checking",
      busyText: "Asking your engine for its keys and bindings.",
      run: async () => {
        alert.set(null);
        c.setBusy(true);
        await refreshDiscovery();
        c.setBusy(false);
        const s = setupModel().get();
        if (stepDone(s, "apply")) return c.next();
        alert.set(s.facts.keysReady ? "The keys are in. Your engine does not report every binding yet. Deploy, then check again." : "Your engine does not report the keys yet. Set the secrets and deploy, then check again.");
      },
    },
  };
}

// ---- Revoke -----------------------------------------------------------------------------------------------------

// The attestation is a tick the user makes, then Continue: one Enter or one stray click never records it. Each
// "Paste another token" can be a new token, so with more than one use the question asks for each of them.
export function revoke(c: QCtx): QView {
  let ticked = false;
  const uses = Math.max(1, c.s.draft.deployTokenUses);
  const tick = checkRow({ label: uses === 1 ? "I revoked the deploy token." : "I revoked each deploy token.", checked: false, onChange: (v) => { ticked = v; c.refresh(); } });
  return {
    title: uses === 1 ? "Revoke the deploy token in Cloudflare" : "Revoke the deploy tokens in Cloudflare",
    lede: [uses === 1 ? "Your keys are installed. Your engine did not keep the token, so revoke it now." : "Your keys are installed. Your engine kept none of the tokens, so revoke them now."],
    body: [
      h("p", { class: "fb-row" }, uses === 1 ? `Delete the token you made today from the ${DEPLOY_TOKEN_TEMPLATE} template.` : `You pasted a deploy token ${uses} times. Delete each token you made today from the ${DEPLOY_TOKEN_TEMPLATE} template.`, " ", externalLink("Open API Tokens", CF_API_TOKENS)),
      tick.el,
    ],
    enterFromHeading: false,
    primary: {
      label: "Continue",
      reason: () => (ticked ? null : "Tick the box first."),
      run: () => {
        if (!ticked) return;
        markDeployTokenRevoked(true);
        c.answer("revoke");
        c.next();
      },
    },
    secondary: [textButton("Remind me at the end", () => { c.answer("revoke"); c.next(); })],
  };
}

// revokePin is the persistent reminder on every view after a deferred revoke, until the user ticks it in
// place. The tick is the attestation; nothing records it but the user's own tick.
export function revokePin(onDone?: () => void): HTMLElement | null {
  const d = setupModel().get().draft;
  if (!d.deployTokenUsed || d.deployTokenRevoked) return null;
  const el = h("div", { class: "fb-msg fb-msg--warn fb-pin", role: "status" }, svgIcon(ICON_ALERT, { size: 16 }));
  const many = d.deployTokenUses > 1;
  const tick = checkRow({
    label: many ? "I revoked each of them in Cloudflare." : "I revoked it in Cloudflare.",
    checked: false,
    onChange: (v) => {
      if (!v) return;
      markDeployTokenRevoked(true);
      el.className = "fb-msg fb-msg--info fb-pin";
      el.replaceChildren(svgIcon(ICON_CHECK, { size: 16 }), h("span", { class: "fb-msg__text" }, many ? "You confirmed you revoked each deploy token." : "You confirmed you revoked the deploy token."));
      onDone?.();
    },
  });
  el.appendChild(h("div", { class: "fb-msg__text fb-pin__body" }, h("span", d.deployTokenUses > 1 ? "Revoke each deploy token you pasted." : "Revoke the deploy token."), externalLink("Open API Tokens", CF_API_TOKENS), tick.el));
  return el;
}
