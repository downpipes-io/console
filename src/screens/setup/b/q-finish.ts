// Focus Flow Finish and the optional steps. At Finish the plan column slides into the stage and becomes the
// receipt: the same "Your backup plan" title, the same line style, each decision with its final value, and
// the optional next steps as the plan's last group. It carries the plan's transition name, so the column
// travels from the right into the stage. "You are protected" appears only here, only once the first run is
// sealed and verified (canSayProtected), and only when nothing is left open: a deploy token the user chose to
// revoke later, or custodian shares not made. While an item is open, the headline says what is true (the
// backup is sealed and verified) and each open item sits in the receipt, in the warn tone, with the action
// that closes it. A first run that sealed on an engine with verify-at-seal switched off is an open item too:
// the backup is sealed but no check read it back, so the headline says "sealed" and the receipt offers a
// restore test. Two more items stay open until the engine says otherwise: a posture statement the engine did
// not record, and credentials saved before the keys that the engine did not report encrypting (the key
// install's re-wrap report; the self-deploy route runs no re-wrap at all).
//

import { h, svgIcon } from "../../../lib/dom.ts";
import { ICON_ALERT, ICON_CHECK, ICON_SHIELD_CHECK, ICON_X_CIRCLE } from "../../../lib/icons.ts";
import { callerEffectiveCapabilities, type Role } from "../../../lib/identity.ts";
import { partitionGrantableBuiltinRoles, withheldBuiltinRolesNote } from "../../access-security/roles-helpers.ts";
import { caller, navigate } from "../../../lib/nav.ts";
import { canCap, capGateReason } from "../../common.ts";
import { recordFormRefused } from "../../../lib/client-diag/ring.ts";
import {
  buildReceipt, canSayProtected, effectivePosture, firstRunDone, type EngineCheck, finishNextSteps, finishSetup, grantRole, hardeningSuggestions, markDeployTokenRevoked, PROVIDERS_INFO, pickedResources, type RestoreApprovalId,
  ROLES, readEngineChecks, recordPostureAgain, restoreApprovalChoices, type SetupSnapshot, setRestoreApproval, setupModel, skipTeam,
} from "../../../lib/setup-flow/index.ts";
import { setupDoneElsewhere, sharesMade } from "./flow.ts";
import { CF_API_TOKENS, checkRow, externalLink, field, message, openSheet, textButton, tileGroup } from "./kit.ts";
import { accountName } from "./plan.ts";
import type { QCtx, QView } from "./types.ts";

const TYPE_SHORT: Record<string, string> = { kv: "KV", r2: "R2", d1: "D1", secrets: "secret", "cf-config": "configuration", workers: "Workers", stream: "Stream", images: "Images" };

interface ReceiptRow {
  label: string;
  value: string;
  // "warn" marks an item still open; its row carries the action that closes it.
  state: "set" | "warn";
  extra?: Node[];
}

// receiptRows names everything CONTRACT requirement 14 asks for, in the plan's line style. The deploy token
// row is also where an open item is closed: the revoke tick.
function receiptRows(c: QCtx, s: SetupSnapshot): ReceiptRow[] {
  const r = buildReceipt(s);
  const d = s.draft;
  const f = s.facts;
  const v = (rows: Array<{ label: string; value: string }>, label: string): string => rows.find((x) => x.label === label)?.value ?? "";
  const provider = PROVIDERS_INFO.find((p) => p.id === d.provider)?.label ?? "";
  const acct = d.provider !== "r2" ? "outside Cloudflare" : d.otherAccount ? `in account ${d.r2AccountId}` : `in ${accountName(s)}`;
  const lock = d.provider === "r2" ? "off" : v(r.destination, "Immutability").toLowerCase();
  const split = d.custody === "mofn-split";
  const noShares = split && !sharesMade();
  const custodians = split ? `${d.splitShares} custodians, any ${d.splitThreshold} recover` : "1 custodian";
  const offline = noShares ? "Split chosen, shares not made." : d.possession === "match" ? "You confirmed identity.key is offline, file checked." : d.keysSaved ? "You confirmed identity.key is offline." : "identity.key offline: not confirmed.";
  const recorded = d.postureRecorded === true ? "recorded by your engine" : d.postureRecorded === false ? "not recorded by your engine" : "engine record not reported";
  const statement = v(r.posture, "Statement").replace(", hash ", ", ");
  const run = d.firstRun;
  const entry = run ? (f.runs[run.downpipeId] ?? []).find((e) => e.runId === run.runId) : undefined;
  const when = entry ? new Date(entry.startedAt) : null;
  const time = when && !Number.isNaN(when.getTime()) ? `, ${when.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false })} ${when.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}` : "";

  const uses = Math.max(1, d.deployTokenUses);
  const usedText = uses === 1 ? "Used once" : `${uses} tokens pasted`;
  const deploy: ReceiptRow = !d.deployTokenUsed
    ? { label: "Deploy token", value: d.applyRoute === "self-deploy" ? "Not used: you deployed yourself." : "Not used.", state: "set" }
    : !d.deployTokenRevoked
      ? {
          label: "Deploy token",
          value: uses === 1 ? `${usedText}, not confirmed revoked.` : `${usedText}, none confirmed revoked. Revoke each one.`,
          state: "warn",
          extra: [
            externalLink("Open API Tokens", CF_API_TOKENS),
            checkRow({ label: uses === 1 ? "I revoked it in Cloudflare." : "I revoked each of them in Cloudflare.", checked: false, onChange: (on) => { if (on) { markDeployTokenRevoked(true); c.rerender(); } } }).el,
          ],
        }
      : { label: "Deploy token", value: `${usedText}, revoked.`, state: "set" };
  // Keys this tab's setup did not make have no statement, custody choice or files recorded here: deploy.sh makes
  // them before the console first loads. A tab resuming this setup's unfinished first backup takes up the whole
  // carried draft, key state included (model.ts syncCarry), so that path does not land here; what does is a
  // concurrent tab whose own key ceremony this tab's sessionStorage draft never saw. The rows say so rather than
  // reading as choices left undone, and name both, since the tab cannot tell them apart.
  const keysBefore = !d.keysGenerated && !d.keysSent && f.keysReady;
  // The posture the engine's keys set, when it differs from the one confirmed here (B1): an open item.
  const postureDiffers = !keysBefore && d.posture !== null && f.keysReady && f.enginePosture !== null && f.enginePosture !== d.posture;
  const postureRow: ReceiptRow = keysBefore
    ? { label: "Key posture", value: `${v(r.posture, "Key posture")}.`, state: "set" }
    : postureDiffers
      ? { label: "Key posture", value: `Your engine holds ${f.enginePosture === "operational" ? "operational" : "offline-only"} keys, not the posture you confirmed here. Check it on the Keys screen.`, state: "warn", extra: [textButton("Open Keys", () => navigate("/keys"))] }
      : d.postureRecorded === false
        ? { label: "Key posture", value: `${v(r.posture, "Key posture")}. ${statement}, not recorded by your engine${d.postureRefusal !== null ? ` (${d.postureRefusal})` : ""}.`, state: "warn", extra: [recordAgain(c)] }
        : { label: "Key posture", value: `${v(r.posture, "Key posture")}. ${statement}, ${recorded}.`, state: "set" };
  // A destination the deployment set (setup-state source "deploy") was not answered here.
  const deployDest = f.setup?.destination.source === "deploy" && d.bucket.trim() === "";
  const creds = credentialsRow(c, s, keysBefore);
  return [
    postureRow,
    keysBefore
      ? { label: "Custody", value: "Your keys were made in another tab or before this setup. Keep identity.key offline, away from this computer.", state: "set" }
      : { label: "Custody", value: `${v(r.custody, "Custody scheme")}, ${custodians}. ${offline}`, state: noShares ? "warn" : "set" },
    ...(creds !== null ? [creds] : []),
    deployDest
      ? { label: "Destination", value: `${v(r.destination, "Provider")}, set by your deployment.`, state: "set" }
      : { label: "Destination", value: `${provider}, ${v(r.destination, "Bucket")}, ${acct}. Object lock ${lock}.`, state: "set" },
    { label: "Sources", value: pickedResources(s).map((x) => `${x.name} (${TYPE_SHORT[x.kind] ?? x.kind})`).join(", "), state: "set" },
    { label: "Schedule", value: `${v(r.schedule, "Schedule")}. ${v(r.schedule, "Retention")}. Restore tests ${effectivePosture(f, d) === "operational" ? v(r.schedule, "Restore test").toLowerCase() : "attended"}.`, state: "set" },
    deploy,
    // The engine's own run time (durationMs, from start to settle), named as the engine's so it is not read as
    // the time the run view counted from the moment it began to watch. An ok run with no seal verdict (the
    // engine has verify-at-seal switched off) is open: a restore test is what proves it.
    entry?.status === "ok" && entry.sealVerification === undefined
      ? {
          label: "First run",
          value: `${v(r.firstRun, "Result")}${time}.${entry.durationMs !== undefined ? ` Engine run time ${(entry.durationMs / 1000).toFixed(1)} s.` : ""} Your engine has verify-at-seal switched off.`,
          state: "warn",
          extra: [textButton("Run a restore test", () => navigate("/restore"))],
        }
      : { label: "First run", value: `${v(r.firstRun, "Result")}${time}.${entry?.durationMs !== undefined ? ` Engine run time ${(entry.durationMs / 1000).toFixed(1)} s.` : ""}`, state: "set" },
  ];
}

// recordAgain is the posture row's action: post the statement again. On an answer the receipt is drawn again,
// so the row reads recorded, or the engine's new reason; an action that could not post says why beside it.
function recordAgain(c: QCtx): HTMLElement {
  const note = h("span", { class: "fb-pl__note", role: "status" });
  const btn = textButton("Record it again", () => {
    note.textContent = "";
    void recordPostureAgain().then((r) => {
      if (r.ok) c.rerender();
      else note.textContent = r.error.message;
    });
  });
  return h("span", { class: "fb-pl__again" }, btn, note);
}

// credentialsRow is the credentials this setup stored before the keys existed: the read-only token (Connect)
// and a destination credential the console saved (Destination). The engine encrypts them when the key install
// puts the wrap key, and says so in its answer (KeyInstallResult.rewrap). Only that report closes the item: an
// answer without it, a pass that left any unencrypted, and the self-deploy route (wrangler sets the wrap key and
// runs no engine route, so nothing re-encrypts) each leave it open with the remedy, saving them again. null
// when the setup stored nothing before the keys, or the keys came first.
function credentialsRow(c: QCtx, s: SetupSnapshot, keysBefore: boolean): ReceiptRow | null {
  const d = s.draft;
  const f = s.facts;
  if (keysBefore || !f.keysReady) return null;
  const token = f.tokenPresent === true;
  const dest = f.setup?.destination.configured === true && f.setup.destination.source === "console";
  if (!token && !dest) return null;
  const which = [token ? "the read-only token" : null, dest ? "the destination key" : null].filter((x): x is string => x !== null).join(" and ");
  if (d.credentialsResaved) return { label: "Saved credentials", value: "You saved them again after the keys, so your engine encrypted them.", state: "set" };
  // Saving again is the user's own act on another screen, so, as with the revoke, only their tick closes it.
  const resaved = checkRow({ label: "I saved them again.", checked: false, onChange: (on) => { if (on) { setupModel().update({ credentialsResaved: true }); c.rerender(); } } }).el;
  const actions: Node[] = [...[token ? textButton("Replace the token", () => navigate("/sources")) : null, dest ? textButton("Destinations", () => navigate("/destinations")) : null].filter((x): x is HTMLButtonElement => x !== null), resaved];
  const rw = d.rewrap;
  if (!d.keysSent) {
    return { label: "Saved credentials", value: `Your own wrangler set the wrap key, and that does not encrypt what was saved before it. Save ${which} again.`, state: "warn", extra: actions };
  }
  if (rw === null) {
    return { label: "Saved credentials", value: `Your engine did not report encrypting ${which}, saved before the keys. Save ${which === "the read-only token" ? "it" : "them"} again.`, state: "warn", extra: actions };
  }
  if (!rw.ok || rw.leftPlaintext > 0) {
    const n = rw.leftPlaintext;
    const classes = rw.failedClasses.length > 0 ? ` (${rw.failedClasses.join(", ")})` : "";
    return { label: "Saved credentials", value: `${n > 0 ? `${n} saved ${n === 1 ? "credential is" : "credentials are"}` : "Saved credentials may be"} not encrypted${classes}. Save ${which} again.`, state: "warn", extra: actions };
  }
  return { label: "Saved credentials", value: `Encrypted by your engine when your keys were installed (${rw.wrapped} ${rw.wrapped === 1 ? "credential" : "credentials"}).`, state: "set" };
}

function nextSteps(c: QCtx, s: SetupSnapshot): HTMLElement {
  const d = s.draft;
  const status: Record<string, string | null> = {
    team: d.grants.length > 0 ? `${d.grants.length} invited` : d.teamSkipped ? "Skipped, only you have access" : null,
    approval: d.restoreApproval === "second" ? "A second approver" : d.restoreApproval === "solo" ? "On your own" : d.restoreApproval === "later" ? "Decide later" : null,
    hardening: null,
  };
  const skip: Record<string, string> = {
    team: "Skip: only you have access.",
    approval: "Skip: you restore alone.",
    hardening: "Skip: nothing changes.",
  };
  const btn: Record<string, string> = { team: "Invite", approval: "Choose", hardening: "Review" };
  const label: Record<string, string> = { team: "Your team", approval: "Restore approval", hardening: "Hardening" };
  return h(
    "section",
    { class: "fb-pg fb-next" },
    h("h3", { class: "fb-pg__name" }, "Optional next steps"),
    h(
      "ul",
      { class: "fb-pg__lines" },
      ...finishNextSteps(s).map((x) => {
        const st = status[x.id] ?? null;
        return h(
          "li",
          { class: `fb-pl fb-pl--${st !== null ? "set" : "default"}` },
          h("span", { class: "fb-pl__glyph", "aria-hidden": "true" }, st !== null ? svgIcon(ICON_CHECK, { size: 14 }) : h("span", { class: "fb-dot fb-dot--default" })),
          h("span", { class: "fb-pl__label" }, label[x.id] ?? x.label),
          h("span", { class: "fb-pl__value" }, st ?? skip[x.id] ?? x.skipDefault),
          h("button", { "data-dp": "setup.button.go", class: "fb-pl__change", type: "button", "aria-label": `${btn[x.id]}: ${label[x.id] ?? x.label} (optional)`, on: { click: () => c.go(x.id) } }, btn[x.id] ?? "Open"),
        );
      }),
    ),
  );
}

export function finish(c: QCtx): QView {
  const s = c.s;
  // done: the first backup ran and sealed (First backup is complete). sealed: the engine also verified the seal,
  // the only licence for "verified" and "protected" copy.
  const done = firstRunDone(s.facts, s.draft);
  const sealed = canSayProtected(s);
  const rows = receiptRows(c, s);
  const open = rows.filter((r) => r.state === "warn").length;
  const protectedNow = sealed && open === 0;
  const plan = h(
    "div",
    { class: "fb-plan__body fb-receipt-plan" },
    h("h2", { class: "fb-plan__title" }, "Your backup plan"),
    h(
      "ul",
      { class: "fb-pg__lines fb-receipt" },
      ...rows.map((r) => h(
        "li",
        { class: `fb-pl fb-pl--${r.state}` },
        h("span", { class: "fb-pl__glyph", "aria-hidden": "true" }, svgIcon(r.state === "warn" ? ICON_ALERT : ICON_CHECK, { size: 14 })),
        h("span", { class: "fb-pl__label" }, r.label),
        h("span", { class: "fb-pl__value" }, r.value, r.extra && r.extra.length > 0 ? h("span", { class: "fb-pl__acts" }, ...r.extra) : null),
      )),
    ),
    nextSteps(c, s),
  );
  // What Overview says next, named here so the two screens do not seem to disagree: a sealed backup is not a
  // proven restore (lib/protection-statement.ts: "unproven" until a restore test or a restore proof lands).
  const nextProof = done ? h("p", { class: "fb-note fb-next-proof" }, "A sealed backup is not yet a proven restore. Overview lists it as not proven until a restore test passes.") : null;
  return {
    title: !done ? "Your first backup is not sealed yet" : !sealed ? "Your first backup is sealed" : protectedNow ? "You are protected" : "Your first backup is sealed and verified",
    // While an item is open, the headline says only what is true and the lede counts what waits below.
    ...(protectedNow ? { lede: [h("span", { class: "fb-chip" }, svgIcon(ICON_SHIELD_CHECK, { size: 14 }), "Sealed and verified")] } : done && open > 0 ? { lede: [open === 1 ? "One item below is still open." : `${open} items below are still open.`] } : {}),
    body: nextProof !== null ? [plan, nextProof] : [plan],
    receipt: true,
    // Enter on the h1 (where focus lands) must not leave setup before the user has read or printed this.
    enterFromHeading: false,
    primary: { label: "Open the console", run: () => void finishSetup(sealed) },
    secondary: [h("button", { "data-dp": "setup.button.finish", class: "btn btn--secondary btn--lg", type: "button", on: { click: () => { if (typeof window.print === "function") window.print(); } } }, "Print receipt")],
  };
}

// ---- Optional: hardening ------------------------------------------------------------------------------------------

export function hardening(c: QCtx): QView {
  const s = c.s;
  // Each suggestion (receipt.ts hardeningSuggestions) gets the action that does it: the screen that owns it.
  const act = (x: string): Node[] => {
    if (x.startsWith("Revoke")) return [];
    const [label, href] = x.includes("destination") ? ["Destinations", "/destinations"] : x.includes("attended verification") ? ["Restore", "/restore"] : ["Security Centre", "/security"];
    return [textButton(label, () => navigate(href))];
  };
  const items: Array<[string, Node[]]> = hardeningSuggestions(s).map((x) => [x, act(x)]);
  items.push(
    ["Put Cloudflare Access in front of the console.", [textButton("Access", () => navigate("/access"))]],
    ["Turn on outbound email for alerts.", [
      textButton("How", () => openSheet({ title: "Turn on outbound email", body: [outboundEmailHowTo()], opener: document.activeElement as HTMLElement | null }), { "aria-label": "How to turn on outbound email" }),
      textButton("Notifications", () => navigate("/notifications")),
    ]],
  );
  items.push(["See what your engine reports about its own set-up.", [textButton("Check my engine", () => c.go("check"))]]);
  return {
    eyebrow: "Optional, after your first backup",
    hidePlan: true,
    title: "Make your setup harder to break",
    lede: ["Each suggestion is optional. Each action opens its own question or screen."],
    body: [h("ul", { class: "fb-hard" }, ...items.map(([t, acts]) => h("li", { class: "fb-hard__row" }, h("span", t), acts.length > 0 ? h("span", { class: "fb-hard__acts" }, ...acts) : null)))],
    primary: { label: "Back to the receipt", run: () => c.go("finish", { back: true }) },
  };
}

// outboundEmailHowTo is the one place setup says how to turn on outbound email. The engine sends through the
// Email Service send binding (its wrangler.toml [[send_email]] and its preflight "email-sending" probe), so the
// sender domain is onboarded under Email Sending, not Email Routing (Cloudflare's inbound forwarding product),
// and role-invite email also needs INVITE_EMAIL_FROM (engine env.d.ts).
export function outboundEmailHowTo(): HTMLElement {
  return h(
    "div",
    { class: "fb-extra" },
    h("p", { class: "fb-note" }, "Optional. Alert, expiry, invite and custody-share emails need it."),
    h("p", { class: "fb-note" }, "In the Cloudflare dashboard, open Compute, then Email Service, then Email Sending, and onboard your sender domain. Keep the EMAIL binding and set EMAIL_FROM to an address on that domain at deploy. Invite emails also need INVITE_EMAIL_FROM."),
    h("p", { class: "fb-note" }, "Without outbound email the console still works, but it cannot send email."),
  );
}

// ---- Optional: the engine's own check (the readiness card, read only) ------------------------------------------------

export function check(c: QCtx): QView {
  const list = h("ul", { class: "fb-hard", "aria-live": "polite" }, h("li", { class: "fb-hard__row" }, h("span", { class: "fb-note" }, "Reading your engine.")));
  const paint = (rows: EngineCheck[]): void => {
    list.replaceChildren(...rows.map((r) => h(
      "li",
      { class: `fb-hard__row fb-checkrow fb-checkrow--${r.ok ? "ok" : "fail"}` },
      h("span", { class: "fb-checkrow__head" }, svgIcon(r.ok ? ICON_CHECK : ICON_X_CIRCLE, { size: 14 }), h("span", `${r.name}: ${r.word}`)),
      h("span", { class: "fb-note" }, r.detail),
    )));
  };
  const alert = message("error");
  queueMicrotask(() => {
    void readEngineChecks().then((r) => {
      if (r.ok) paint(r.data);
      else {
        list.replaceChildren();
        alert.set(`${r.error.message} Nothing depends on this check.`);
      }
    });
  });
  // On a console set up elsewhere (the palette's "Check engine wiring") there is no receipt in this tab to go
  // back to, so the way out is the console itself.
  if (setupDoneElsewhere(c.s)) {
    return {
      eyebrow: "Your engine",
      hidePlan: true,
      title: "What your engine reports",
      lede: ["A read-only check. Only items the engine has observed are listed."],
      body: [list, alert.el],
      primary: { label: "Open the console", run: () => navigate("/") },
    };
  }
  return {
    eyebrow: "Optional, after your first backup",
    hidePlan: true,
    title: "What your engine reports",
    lede: ["A read-only check. Only items the engine has observed are listed."],
    body: [list, alert.el],
    primary: { label: "Back", run: () => c.go("hardening", { back: true }) },
    secondary: [textButton("Back to the receipt", () => c.go("finish", { back: true }))],
  };
}

// ---- Optional: team -------------------------------------------------------------------------------------------------

export function team(c: QCtx): QView {
  // On a console set up elsewhere (the "Invite your team" link after a new Owner registers) there is no receipt
  // in this tab to go back to, so the way out is the console itself, and leaving records no skip.
  const alone = setupDoneElsewhere(c.s);
  const eyebrow = alone ? "Your team" : "Optional, after your first backup";
  const back = alone
    ? textButton("Open the console", () => navigate("/"))
    : textButton("Back to the receipt", () => { if (setupModel().get().draft.grants.length === 0) skipTeam(); c.go("finish", { back: true }); });
  // POST /admin/roles is gated on roles.write (the Owner and Access admin roles), the capability the Access
  // roles table uses. A caller without it sees why, in plain words, and no form the engine would refuse.
  if (!canCap("roles.write")) {
    return {
      eyebrow,
      hidePlan: true,
      title: "Invite your team",
      lede: ["Inviting teammates and assigning roles needs permission to manage roles and members, held by the Owner and Access admin roles."],
      body: [h("p", { class: "fb-note" }, capGateReason("roles.write"))],
      primary: alone ? { label: "Open the console", run: () => navigate("/") } : { label: "Back to the receipt", run: () => c.go("finish", { back: true }) },
    };
  }
  // The invite email keeps the id the field catalogue and the support ring already know it by
  // (CLIENT_DIAG_FORM_FIELDS "ob-invite-email"), so a refused address is one row support can read.
  const email = field({ id: "ob-invite-email", label: "Teammate email", type: "email", autocomplete: "email", placeholder: "teammate@example.com", doc: { href: "https://docs.downpipes.io/identity-access/roles-and-capabilities", anchor: "the-six-roles-at-a-glance" } });
  const done = h("div", { class: "fb-msg fb-msg--ok", role: "status", hidden: true });
  const alert = message("error");
  const warn = message("warn");
  // The tiles offer only the built-in roles this caller can grant, with the check the Access screen's members
  // form applies (partitionGrantableBuiltinRoles). The engine refuses the rest after the press: a role that
  // gives a capability the caller does not hold, and Owner from anyone who is not an Owner.
  const who = caller();
  const callerRole = who?.role ?? "viewer";
  const builtins = partitionGrantableBuiltinRoles(ROLES.map((r) => r.id), callerRole, callerEffectiveCapabilities(callerRole, who?.customRole ?? null));
  const offered = ROLES.filter((r) => builtins.grantable.includes(r.id));
  const roles = tileGroup<Role>({ name: "role", legend: "Role", choices: offered.map((r) => ({ id: r.id, label: r.label, lines: [r.consequence] })), selected: "viewer", columns: 3 });
  const withheld = builtins.withheld.length > 0 ? h("p", { class: "fb-note" }, withheldBuiltinRolesNote(builtins.withheld)) : null;
  const run = async (): Promise<void> => {
    email.setError(null);
    alert.set(null);
    warn.set(null);
    done.hidden = true;
    c.setBusy(true);
    const r = await grantRole(email.input.value, roles.value() ?? "viewer");
    c.setBusy(false);
    if (!r.ok) {
      if (r.error.field === "email") {
        // The catalogued control id rides, never the typed address (lib/client-diag/ring.ts recordFormRefused).
        recordFormRefused("ob-invite-email", email.input.value);
        email.setError("Type a full email address, for example sam@northwind.example.");
        email.input.focus();
      } else if (r.error.kind !== "unauthorised") {
        // The entry stays in the form, so a retry is one press.
        alert.set(`${r.error.message} No role was granted.`, textButton("Try again", () => void run()));
      }
      return;
    }
    if (r.data.queued) return warn.set(`The grant for ${r.data.email} waits for a second approver before it takes effect.`);
    const label = ROLES.find((x) => x.id === r.data.role)?.label ?? r.data.role;
    // The engine mints a one-time invite token with the grant: the register link is the only thing that lets
    // the person enrol a passkey. It is shown once and never stored, the recovery-codes precedent.
    const link = r.data.inviteToken ? `${location.origin}/#/register?invite=${r.data.inviteToken}` : null;
    done.replaceChildren(h("p", { class: "fb-msg__text" }, `Role stored for ${r.data.email} as ${label}.`));
    if (link) {
      done.append(
        h("p", { class: "fb-row" }, h("code", { class: "fb-invite-link", tabindex: "0", "aria-label": "Invite link" }, link), textButton("Copy", () => { if (navigator.clipboard) void navigator.clipboard.writeText(link); }, { "aria-label": "Copy the invite link" })),
        h("p", { class: "fb-note" }, "Send them this link. It opens passkey set-up. Shown once; the console does not store it."),
      );
    } else done.appendChild(h("p", { class: "fb-note" }, "Tell them out of band if invite email is not set up on your engine."));
    done.hidden = false;
    email.input.value = "";
  };
  return {
    eyebrow,
    hidePlan: true,
    title: "Invite your team",
    lede: ["Give a teammate a role. They get a one-time invite link."],
    body: [
      email.el,
      roles.el,
      ...(withheld ? [withheld] : []),
      // Stated before the action: the passkey check "Grant role" can open (POST /admin/roles is step-up gated),
      // and what email the engine sends. The console sends none and holds no mail credential.
      h("p", { class: "fb-note" }, "You may be asked to confirm with your own passkey. If you dismiss that prompt, or it fails, no role is granted."),
      h("p", { class: "fb-note" }, "If invite email is set up on your engine, it emails them. The console sends no email."),
      done,
      alert.el,
      warn.el,
    ],
    focus: () => email.input,
    primary: { label: "Grant role", busyLabel: "Granting", run },
    secondary: [back],
  };
}

// ---- Optional: restore approval -------------------------------------------------------------------------------------

export function approval(c: QCtx): QView {
  const alert = message("error");
  const only = caller()?.isOnlyOwner === true;
  const labels: Record<RestoreApprovalId, string> = { solo: "On my own", second: "A second approver", later: "Decide later" };
  const tiles = tileGroup<RestoreApprovalId>({
    name: "approval",
    labelledBy: "fb-h1",
    choices: restoreApprovalChoices(only).map((x) => ({ id: x.id, label: labels[x.id], lines: [x.consequence], ...(x.unavailable !== undefined ? { unavailable: x.unavailable } : {}) })),
    selected: c.s.draft.restoreApproval,
    showChosen: true,
    columns: 3,
    onChange: () => c.refresh(),
  });
  return {
    eyebrow: "Optional, after your first backup",
    hidePlan: true,
    title: "Who can approve a restore?",
    lede: ["A restore writes archived data over live data. It is not rolled back."],
    body: [
      tiles.el,
      // Stated before the action: "Save" can open a passkey check (POST /admin/config/restore-approval-policy
      // is step-up gated).
      h("p", { class: "fb-note" }, "You may be asked to confirm with your own passkey. If you dismiss that prompt, or it fails, nothing changes."),
      alert.el,
    ],
    primary: {
      label: "Save",
      busyLabel: "Saving",
      reason: () => (tiles.value() === null ? "Choose one." : null),
      run: async () => {
        const v = tiles.value();
        if (v === null) return;
        alert.set(null);
        c.setBusy(true);
        const r = await setRestoreApproval(v);
        c.setBusy(false);
        if (!r.ok) return alert.set(r.error.message);
        c.go("finish", { back: true });
      },
    },
    secondary: [textButton("Back to the receipt", () => c.go("finish", { back: true }))],
  };
}
