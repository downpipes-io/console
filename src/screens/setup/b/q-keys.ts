// Focus Flow questions for step 4, Keys, after the posture: custody (chosen BEFORE the keys exist, so the
// first recovery sheet records it, and the same question makes the keys in this browser), generate (only
// when leaving setup or a reload cleared the keys, or to make them again) and saved (an instruction the user acknowledges:
// move identity.key off this computer; the browser can also check the file, and uploads nothing). Every
// safety-critical call is the foundation's action over the existing helpers; the split and the optional
// encryption mount the existing custody panels unchanged.

import { type CustodyPanelContext, renderSplit, renderTier12 } from "../../../components/custody-step-panels.ts";
import { renderReassemblyCard, wipeOnDisconnect } from "../../restore-flow/reassembly.ts";
import { confirmModal } from "../../../components/modal.ts";
import { makeSplitSignoffs } from "../../../lib/custody.ts";
import { h, svgIcon } from "../../../lib/dom.ts";
import { readTextFileBounded } from "../../../lib/file-size-guard.ts";
import { ICON_ALERT, ICON_CHECK, ICON_REFRESH, ICON_SHIELD_CHECK } from "../../../lib/icons.ts";
import { enter } from "../../../lib/motion.ts";
import {
  CUSTODY_SCHEMES, CUSTODY_SPLIT_BOUNDS, ceremonyFileNames, confirmKeysSaved, currentCeremony, downloadText, generateKeys,
  openRecoverySheet, recordPostureAgain, redownloadFile, setupModel, verifyIdentityFile, verifyRecoveredIdentity,
} from "../../../lib/setup-flow/index.ts";
import { getEngine } from "../../../lib/store.ts";
import { setSharesMade, sharesMade } from "./flow.ts";
import { checkRow, line, message, openSheet, textButton, tileGroup } from "./kit.ts";
import { accountName } from "./plan.ts";
import type { QCtx, QView } from "./types.ts";

type Scheme = (typeof CUSTODY_SCHEMES)[number]["id"];

// One line per scheme, shorter than the Keys screen's summaries (the labels are the recovery sheet's own).
const CUSTODY_LINE: Record<Scheme, string> = {
  "password-manager": "A password manager or team vault.",
  "encrypted-usb-paper": "A hardware-encrypted drive, with a printed copy.",
  "mofn-split": "Any M of N people recover it together.",
};

// What leaves this browser, precisely: the POST /admin/keys/install body (lib/setup-flow/install.ts
// installCeremonyKeys) carries the signer private, the configuration recovery pair and wrap key, the public
// keys, and the operational pair only under that posture. The break-glass private (identity.key) has no field
// in it. These two sentences match that body.
export const KEYS_TRUST_OFFLINE = "identity.key never leaves this device. At Apply, your engine gets the signing key, the configuration keys and the public keys.";
export const KEYS_TRUST_OPERATIONAL = "identity.key never leaves this device. At Apply, your engine gets the signing key, the configuration keys, the public keys and the operational key, which can decrypt backups.";
function keysTrust(operational: boolean): HTMLElement {
  return line(ICON_SHIELD_CHECK, operational ? KEYS_TRUST_OPERATIONAL : KEYS_TRUST_OFFLINE, "fb-line--trust");
}

// Set when a custody change after the keys exist downloaded recovery-sheet.txt again: the Saved question then
// tells the user to destroy the old copy. Cleared when keys are made again.
let sheetReissued = false;

// makeKeys runs the ceremony (the foundation's generateKeys: the files download at once) and opens Saved,
// which shows each file and what to do with it. Shares of earlier keys no longer count.
async function makeKeys(c: QCtx, alert: { set: (m: string | null) => void }): Promise<void> {
  alert.set(null);
  c.setBusy(true);
  const r = await generateKeys();
  c.setBusy(false);
  if (!r.ok) {
    alert.set(r.error.message);
    return;
  }
  setSharesMade(false);
  sheetReissued = false;
  c.go("saved");
}

// makeAgain replaces keys this tab already holds. New keys make every file saved so far useless, so it asks
// first, as the posture change does; Saved then asks again for the tick.
async function makeAgain(c: QCtx, alert: { set: (m: string | null) => void }): Promise<void> {
  const ok = await confirmModal({
    title: "Make new keys?",
    body: "Your saved key files will stop matching. Delete them, then save the new files.",
    confirmLabel: "Make new keys",
    variant: "danger",
  });
  if (ok) await makeKeys(c, alert);
}

// postureNotRecorded fills a warn line: the engine did not record the posture statement, with its reason as it
// gave it, and "Record it again", which says what happened when it fails again. Finish keeps the same item open.
export function postureNotRecorded(warn: { set: (m: string | null, extra?: Node | null) => void }, onRecorded?: () => void): void {
  const why = setupModel().get().draft.postureRefusal;
  const text = `Your engine did not record your posture statement${why !== null ? ` (${why})` : ""}. Your choice still stands.`;
  warn.set(text, textButton("Record it again", () => {
    void recordPostureAgain().then((r) => {
      if (r.ok && r.data.recorded) {
        warn.set(null);
        onRecorded?.();
        return;
      }
      const again = r.ok ? r.data.reason : r.error.message;
      warn.set(`Your engine did not record it again${again !== null ? ` (${again})` : ""}. Your choice still stands.`, textButton("Record it again", () => postureNotRecorded(warn, onRecorded)));
    });
  }));
}

// ---- Custody ----------------------------------------------------------------------------------------------------

function stepper(label: string, value: number, min: () => number, max: () => number, onSet: (v: number) => void): { el: HTMLElement; set: (v: number) => void } {
  const out = h("output", { class: "fb-stepper__value" }, String(value));
  let v = value;
  const id = `fb-step-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const set = (n: number): void => {
    v = Math.max(min(), Math.min(max(), n));
    out.textContent = String(v);
    onSet(v);
  };
  const minus = h("button", { "data-dp": "setup.button.minus", class: "fb-stepper__btn", type: "button", "aria-label": `Fewer: ${label}`, on: { click: () => set(v - 1) } }, "−");
  const plus = h("button", { "data-dp": "setup.button.plus", class: "fb-stepper__btn", type: "button", "aria-label": `More: ${label}`, on: { click: () => set(v + 1) } }, "+");
  out.id = id;
  return { el: h("div", { class: "fb-stepper", role: "group", "aria-label": label }, h("span", { class: "fb-stepper__label" }, label), minus, out, plus), set };
}

function splitDetails(onChange: () => void): HTMLElement {
  const m = setupModel();
  const d = m.get().draft;
  let n = d.splitShares;
  let t = d.splitThreshold;
  const diagram = h("div", { class: "fb-shares", "aria-hidden": "true" });
  const sentence = h("p", { class: "fb-shares__text", "aria-live": "polite" });
  const paint = (): void => {
    diagram.replaceChildren(...Array.from({ length: n }, (_, i) => h("span", { class: `fb-share${i < t ? " fb-share--on" : ""}` })));
    sentence.textContent = `Any ${t} of ${n} custodians can recover the key.`;
    m.update({ splitShares: n, splitThreshold: t });
    onChange();
  };
  let tStep: { set: (v: number) => void } | null = null;
  const nStep = stepper("Shares", n, () => CUSTODY_SPLIT_BOUNDS.minShares, () => CUSTODY_SPLIT_BOUNDS.maxShares, (v) => { n = v; if (t > n) tStep?.set(n); paint(); });
  const tS = stepper("Needed to recover", t, () => CUSTODY_SPLIT_BOUNDS.minThreshold, () => n, (v) => { t = v; paint(); });
  tStep = tS;
  paint();
  return h("div", { class: "fb-extra fb-split" }, h("div", { class: "fb-split__steppers" }, nStep.el, tS.el), diagram, sentence);
}

export function custody(c: QCtx): QView {
  const m = setupModel();
  const s = c.s;
  const d = s.draft;
  const held = currentCeremony() !== null && d.keysGenerated;
  const warn = message("warn");
  const alert = message("error");
  const tiles = tileGroup<Scheme>({
    name: "custody",
    labelledBy: "fb-h1",
    choices: CUSTODY_SCHEMES.map((x) => ({ id: x.id, label: x.label, lines: [CUSTODY_LINE[x.id]], ...(x.id === "mofn-split" ? { extra: () => splitDetails(() => c.refresh()) } : {}) })),
    selected: d.custody,
    showChosen: true,
    columns: 3,
    onChange: () => c.refresh(),
  });
  if (d.postureRecorded === false) postureNotRecorded(warn);
  const chooseFirst = (): string | null => (tiles.value() === null ? "Choose one first." : null);
  return {
    title: "Where does your offline key live?",
    lede: ["The file identity.key opens every backup. Your recovery sheet records this choice."],
    body: [warn.el, tiles.el, held ? null : keysTrust(d.posture === "operational"), alert.el].filter((n): n is HTMLElement => n !== null),
    primary: held
      ? {
          label: c.ret !== null ? "Save and go back" : "Continue",
          reason: chooseFirst,
          run: () => {
            const v = tiles.value();
            if (v === null) return;
            const before = m.get().draft;
            const changed = v !== before.custody;
            m.update({ custody: v });
            if (changed) {
              // The recovery sheet on disk names the old scheme: download it again now (this click is the
              // user gesture the download needs), and Saved says to destroy the old copy.
              m.update({ keysSaved: false });
              const r = redownloadFile("recovery-sheet.txt");
              sheetReissued = r.ok;
              if (v === "mofn-split") setSharesMade(false);
              c.flight(tiles.chosenTitle(), "custody");
              c.go("saved", { ret: c.ret });
              return;
            }
            c.flight(tiles.chosenTitle(), "custody");
            c.next();
          },
        }
      : {
          label: "Make my keys",
          busyLabel: "Making keys",
          busyText: "Making your keys in this browser. Nothing leaves it.",
          reason: chooseFirst,
          run: async () => {
            const v = tiles.value();
            if (v === null) return;
            m.update({ custody: v });
            c.flight(tiles.chosenTitle(), "custody");
            await makeKeys(c, alert);
          },
        },
    secondary: held ? [textButton("Make new keys instead", () => { const v = tiles.value(); if (v !== null) m.update({ custody: v }); void makeAgain(c, alert); })] : [],
  };
}

// ---- The key file bins (Saved and Generate) ---------------------------------------------------------------------

// A purpose line only where the file's job is not plain from its bin.
const PURPOSE: Record<string, string> = {
  "identity.key": "Opens every backup.",
  "signer.pub": "Proves backups came from your engine.",
};
// signer.pub is public, but a trusted offline copy is what shows a swapped signer later.
const OFFLINE = new Set(["identity.key", "recovery-sheet.txt", "signer.pub"]);

function bins(c: QCtx, state: "none" | "made", animate: boolean): HTMLElement {
  const s = setupModel().get();
  const d = s.draft;
  // The files of the keys this tab holds, from the keys themselves: a row never names a file that was not made.
  const held = currentCeremony();
  const files = ceremonyFileNames(state === "made" && held !== null ? (held.operational !== null ? "operational" : "break-glass-only") : d.posture);
  const row = (f: string, i: number): HTMLElement => {
    const refused = d.refusedFiles.includes(f);
    // The browser only started a download: the row says so, and never shows the success check.
    const st = state === "none" ? "Not made" : refused ? "Not downloaded" : f === "recovery-sheet.txt" && sheetReissued ? "Downloaded again" : "Downloaded";
    const el = h(
      "li",
      { class: `fb-file fb-file--${state === "none" ? "none" : refused ? "refused" : "saved"}` },
      h("span", { class: "fb-file__glyph", "aria-hidden": "true" }, state === "made" && refused ? svgIcon(ICON_ALERT, { size: 14 }) : h("span", { class: `fb-dot fb-dot--${state === "none" ? "unset" : "default"}` })),
      h("code", { class: "fb-file__name" }, f),
      h("span", { class: "fb-file__purpose" }, PURPOSE[f] ?? ""),
      h("span", { class: "fb-file__state" }, st),
      state === "made" ? iconButton(`Download ${f} again`, () => { redownloadFile(f); c.rerender(); }) : null,
    );
    if (animate && state === "made") enter(el, { from: "below", distance: 6, duration: "--dur-1", delay: Math.min(i, 2) * 60 });
    return el;
  };
  const off = files.filter((f) => OFFLINE.has(f));
  const pub = files.filter((f) => !OFFLINE.has(f));
  return h(
    "div",
    { class: "fb-bins-wrap" },
    // The account these keys belong to, so a file saved for one client is not filed as another's.
    h("p", { class: "fb-bins__for" }, `Key files for ${accountName(s)}`),
    h(
      "div",
      { class: "fb-bins" },
      h("section", { class: "fb-bin" }, h("h2", { class: "fb-bin__title" }, "Keep offline"), h("ul", { class: "fb-bin__list" }, ...off.map(row))),
      h("section", { class: "fb-bin" }, h("h2", { class: "fb-bin__title" }, "Public copies"), h("ul", { class: "fb-bin__list" }, ...pub.map((f, i) => row(f, i + off.length)))),
    ),
  );
}

// iconButton is the per-file "Download again": a 24 px target with its name in aria-label and a tooltip, so
// four rows do not repeat the same two words.
function iconButton(label: string, onClick: () => void): HTMLButtonElement {
  return h("button", { "data-dp": "setup.button.click#3", class: "fb-iconbtn", type: "button", "aria-label": label, title: label, on: { click: onClick } }, svgIcon(ICON_REFRESH, { size: 14 })) as HTMLButtonElement;
}

// ---- Generate (leaving setup or a reload cleared the keys, or the user asked for new ones) -----------------------

export function generate(c: QCtx): QView {
  const s = c.s;
  const d = s.draft;
  const held = currentCeremony() !== null && d.keysGenerated;
  const alert = message("error");
  const warn = message("warn");
  if (d.keysGenerated && !held) warn.set("Your keys are no longer in this tab. Leaving setup or reloading the page clears them. Make them again, and delete the files you saved before.");
  const again = (): Promise<void> => makeAgain(c, alert);
  return {
    title: held ? "Your keys are in this tab" : "Make your keys in this browser",
    lede: [held ? "Use them, or make new ones." : "Your custody choice goes on the new recovery sheet."],
    body: [warn.el, keysTrust(d.posture === "operational"), bins(c, held ? "made" : "none", false), alert.el],
    primary: held
      ? { label: "Use these keys", run: () => c.go("saved") }
      : { label: "Make my keys", busyLabel: "Making keys", busyText: "Making your keys in this browser. Nothing leaves it.", reason: () => (d.custody === null ? "Choose where you keep the key first." : null), run: () => makeKeys(c, alert) },
    secondary: held ? [textButton("Make new keys instead", () => void again())] : [],
  };
}

// ---- Saved: move identity.key off this computer -----------------------------------------------------------------

// The instruction, worded for the custody scheme the user chose.
const MOVE: Record<Scheme, string> = {
  "password-manager": "Move identity.key into your password manager or team vault. Then delete it from Downloads.",
  "encrypted-usb-paper": "Move identity.key to the encrypted drive, and print the recovery sheet. Then delete it from Downloads.",
  "mofn-split": "Make the shares. Then delete identity.key from Downloads. The shares and identity.key.enc replace it.",
};

// savedKeys is the Saved question. It is not named "saved": the step-up announce gate reads a modal's copy for the
// names of the functions around a gated write, and makeAgain's "Your saved key files" would then read as naming it.
export function savedKeys(c: QCtx): QView {
  const m = setupModel();
  const s = c.s;
  const d = s.draft;
  const ceremony = currentCeremony();
  if (ceremony === null || !d.keysGenerated) return generate(c);
  const scheme: Scheme = d.custody ?? "password-manager";
  const split = scheme === "mofn-split";
  const alert = message("error");
  const okLine = h("p", { class: "fb-msg fb-msg--ok", role: "status", hidden: true });
  let ticked = false;
  const file = h("input", { "data-dp": "setup.file.set", type: "file", accept: ".key,text/plain", class: "visually-hidden", "aria-label": "Your saved identity.key", tabindex: "-1" }) as HTMLInputElement;
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    alert.set(null);
    okLine.hidden = true;
    void (async () => {
      let r: Awaited<ReturnType<typeof verifyIdentityFile>>;
      try {
        // The console's one pre-read ceiling for a key file (lib/file-size-guard.ts): an oversized file is
        // refused before a byte of it is read, as on every other identity.key picker.
        r = await verifyIdentityFile(await readTextFileBounded(f));
      } catch (e) {
        const why = e instanceof Error ? e.message : "";
        r = { ok: false, error: { kind: "validation", message: why.startsWith("that file is") ? `Not read: ${why}.` : "Your browser could not read that file." } };
      } finally {
        file.value = "";
      }
      if (!r.ok) return alert.set(r.error.message);
      if (!r.data.match) return alert.set("This file does not match the keys you just made. Choose the identity.key from this session.");
      okLine.replaceChildren(svgIcon(ICON_CHECK, { size: 16 }), h("span", { class: "fb-msg__text" }, "identity.key matches your new keys."));
      okLine.hidden = false;
    })();
  });
  const panelCtx = (onShares?: () => void): CustodyPanelContext => {
    const cur = m.get().draft;
    const engine = getEngine();
    const ctx: CustodyPanelContext = {
      state: { scheme: cur.custody ?? "password-manager", splitN: cur.splitShares, splitThreshold: cur.splitThreshold, signoffs: cur.custody === "mofn-split" ? makeSplitSignoffs(cur.splitShares) : [] },
      result: ceremony,
      downloadText: (name, content) => {
        const ok = downloadText(name, content, "key-ceremony");
        // A share file is the panel's own report that the split ran (it delivers them after the self-test).
        if (onShares && /^downpipe-share-\d+-of-\d+\.txt$/.test(name)) {
          const now = m.get().draft;
          if (ctx.state.splitN !== now.splitShares || ctx.state.splitThreshold !== now.splitThreshold) {
            // The panel's own N and M won: the plan, the receipt and the recovery sheet follow them.
            m.update({ splitShares: ctx.state.splitN, splitThreshold: ctx.state.splitThreshold });
            sheetReissued = redownloadFile("recovery-sheet.txt").ok;
          }
          if (!sharesMade()) {
            setSharesMade(true);
            // The plan's custody line reads the shares record: re-derive so it says "shares made".
            m.touch();
            onShares();
          }
        }
        return ok;
      },
      emitMeta: () => {},
      ...(engine ? { sendShare: (input) => engine.sendCustodyShare(input) } : {}),
    };
    return ctx;
  };
  // checkShares is the split holder's proof of possession: the existing reassembly card (the same quorum route
  // Restore and Keys offer) rebuilds the key in this browser from the shares and identity.key.enc the user will
  // keep, and the setup compares its public fingerprint with the key made here. Nothing is uploaded; the card
  // zeroes its buffers when the sheet closes or the page goes, and the check zeroes the rebuilt key.
  const checkShares = (): void => {
    const result = message("error");
    const good = h("p", { class: "fb-msg fb-msg--ok", role: "status", hidden: true });
    const card = renderReassemblyCard({
      showDownload: false,
      onRecovered: (identity) => {
        result.set(null);
        good.hidden = true;
        if (identity === null) return result.set("The rebuilt file is not an identity.key.");
        void verifyRecoveredIdentity(identity).then((r) => {
          if (!r.ok) return result.set(r.error.message);
          if (!r.data.match) return result.set("These shares rebuild a different key. Use the shares and identity.key.enc from this session.");
          good.replaceChildren(svgIcon(ICON_CHECK, { size: 16 }), h("span", { class: "fb-msg__text" }, "Your shares rebuild your new key."));
          good.hidden = false;
        });
      },
      onInvalidated: () => {
        result.set(null);
        good.hidden = true;
      },
    });
    wipeOnDisconnect(card.el, () => card.teardown());
    openSheet({ title: "Check your shares", body: [h("p", { class: "fb-note" }, `Load any ${m.get().draft.splitThreshold} shares and identity.key.enc. Your browser rebuilds the key here and uploads nothing.`), card.el, good, result.el], opener: document.activeElement as HTMLElement | null, onClose: () => card.teardown() });
  };
  const fingerprints = (): void => {
    const row = (label: string, fp: string): HTMLElement =>
      h("div", { class: "fb-fp" }, h("span", { class: "fb-fp__label" }, label), h("code", { class: "fb-fp__value" }, fp), textButton("Copy", () => { if (navigator.clipboard) void navigator.clipboard.writeText(fp); }, { "aria-label": `Copy the ${label.toLowerCase()} fingerprint` }));
    openSheet({
      title: "Fingerprints",
      body: [row("Offline key", ceremony.breakGlass.fingerprint), ...(ceremony.operational ? [row("Operational", ceremony.operational.fingerprint)] : []), row("Signer", ceremony.signer.fingerprint)],
      opener: document.activeElement as HTMLElement | null,
    });
  };

  const body: Node[] = [file];
  if (split) {
    // The split runs on the key in this tab, through the existing panel, in a one-level sheet. The line stays
    // (in the warn tone) until the panel has made the shares, and Continue waits for it.
    const sharesLine = message("warn");
    const paintShares = (): void => {
      const cur = m.get().draft;
      if (sharesMade()) {
        sharesLine.el.className = "fb-msg fb-msg--info";
        sharesLine.set(`Shares made: any ${cur.splitThreshold} of ${cur.splitShares}. Give one to each custodian.`);
      } else sharesLine.set(`Make the ${cur.splitShares} custodian shares now, while the key is in this tab.`, textButton("Make the shares", () => {
        // Emailing a share is step-up gated (sendCustodyShare), so the sheet says a passkey prompt may come first,
        // as the Keys screen's custody step does (components/custody-step.ts).
        openSheet({ title: "Make the custodian shares", body: [renderSplit(panelCtx(() => { paintShares(); c.refresh(); })), h("p", { class: "fb-note" }, "You may be asked to confirm with your own passkey when you email a share. If you dismiss that prompt, or it fails, no share is sent.")], opener: document.activeElement as HTMLElement | null });
      }));
    };
    paintShares();
    body.push(sharesLine.el);
  }
  if (sheetReissued) {
    const w = message("warn");
    w.set("recovery-sheet.txt was downloaded again with your new custody choice. Destroy the old copy.");
    body.push(w.el);
  }
  body.push(bins(c, "made", c.ret === null && !sheetReissued));
  const tick = checkRow({
    label: split ? "I deleted identity.key from this computer." : "I moved identity.key off this computer.",
    checked: false,
    onChange: (v) => { ticked = v; c.refresh(); },
  });
  body.push(tick.el, okLine, alert.el);
  body.push(h(
    "p",
    { class: "fb-row" },
    split
      ? textButton("Check your shares", checkShares, { "aria-label": "Check your shares (optional). Your browser rebuilds the key here and uploads nothing." })
      : textButton("Check identity.key", () => file.click(), { "aria-label": "Check identity.key (optional). Your browser reads it here and uploads nothing." }),
    textButton("Open printable sheet", () => void openRecoverySheet()),
    textButton("Show fingerprints", fingerprints),
    split ? null : textButton("Encrypt the key file", () => {
      const cur = m.get().draft.custody;
      openSheet({ title: "Encrypt the key file", body: [line(ICON_SHIELD_CHECK, "Optional. The vault or drive already protects it.", "fb-line--trust"), renderTier12(panelCtx(), cur === "encrypted-usb-paper" ? "encrypted-usb-paper" : "password-manager")], opener: document.activeElement as HTMLElement | null });
    }, { "aria-label": "Encrypt the key file (optional)" }),
  ));
  return {
    title: split ? "Make the shares, then delete identity.key" : "Move identity.key off this computer",
    lede: [MOVE[scheme]],
    body,
    primary: {
      label: c.ret !== null ? "Save and go back" : "Continue",
      reason: () => {
        const cur = m.get().draft;
        if (cur.refusedFiles.length > 0) return `Download ${cur.refusedFiles.join(", ")} first.`;
        if (split && !sharesMade()) return `Make the ${cur.splitShares} shares first.`;
        if (!ticked) return "Tick the box first.";
        return null;
      },
      run: () => {
        const r = confirmKeysSaved();
        if (!r.ok) return alert.set(r.error.message);
        c.next();
      },
    },
  };
}
