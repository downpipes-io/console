// Focus Flow question: key posture, the comparison. Two radio tiles on one shared row grid (same consequence,
// same row, same order), offline first, no default. After a choice the verbatim statement
// (POSTURE_ACK_STATEMENTS, byte for byte), the tick and Confirm appear under the tiles, all in the viewport at
// 1440x900. The plan column is hidden on this view (behind the Plan button) to keep the width and the words.
//
// Each cell restates a clause of that posture's statement and contradicts none of it. The row captions are a
// visible column for sighted readers (aria-hidden); each tile carries the same captions in a hidden
// description, so a screen reader hears "Engine can decrypt: No key in your engine opens them."

import { confirmModal } from "../../../components/modal.ts";
import { h, svgIcon } from "../../../lib/dom.ts";
import { ICON_ALERT, ICON_CHECK } from "../../../lib/icons.ts";
import { enter, motionOK } from "../../../lib/motion.ts";
import { navigate } from "../../../lib/nav.ts";
import type { PostureChoice } from "../../../lib/posture-ack-statements.ts";
import { acknowledgePosture, currentCeremony, POSTURE_TICK_LABEL, POSTURES, setupModel } from "../../../lib/setup-flow/index.ts";
import { clearSensitiveState } from "../../../lib/store.ts";
import { checkRow, externalLink, message, textButton, uid } from "./kit.ts";
import type { QCtx, QView } from "./types.ts";

const CAPTIONS = ["Engine can decrypt", "Restore tests", "Pruning old runs", "Breach or malicious update", "If you lose the offline key", "Changing later"];
// The same captions, shorter, for inside each tile below 768 px, where both tiles repeat them.
const CAPTIONS_SHORT = ["Engine decrypts", "Restore tests", "Pruning", "If breached", "Offline key lost", "Later"];
// Offline cells restate key-posture-ack/v3; operational cells restate key-posture-ack/v1 (lib/posture-ack-statements.ts).
// Two cells are checked against the engine as well: the operational private key exists only as a secret in
// the engine (engine admin/attach.ts:575), so it opens backups only while that engine and its account
// survive; an operational key added later seals only new runs, and earlier runs stay offline-only
// (admin/attach.ts:700-705).
const CELLS: Record<PostureChoice, string[]> = {
  "break-glass-only": [
    "No key in your engine opens them.",
    "Not scheduled. You prove past runs with your key.",
    "By hand, in the console or with the offline reader. Storage grows until then.",
    "Archives stay sealed, but can still be deleted.",
    "Your backups cannot be recovered.",
    "Add an operational key later. Earlier runs stay offline-only.",
  ],
  operational: [
    "Yes. The operational key opens them.",
    "Run on a schedule, without you.",
    "Your engine can prune on your schedule.",
    "Archives could be read or deleted.",
    "Opens them while your engine and account survive.",
    "Removing it does not protect archives already sealed.",
  ],
};
const DOCS = "https://docs.downpipes.io/concepts/choosing-your-key-posture";

export function posture(c: QCtx): QView {
  const m = setupModel();
  const s = c.s;
  if (s.facts.keysReady) return keysAlready(c);
  const d = s.draft;
  let choice: PostureChoice | null = d.posture;
  let ticked = d.postureAcknowledged && d.posture !== null;
  const alert = message("error");
  const group = uid("posture");
  const statementHost = h("div", { class: "fb-statement-host", "aria-live": "polite" });
  const radios: HTMLInputElement[] = [];
  const titles = new Map<PostureChoice, HTMLElement>();

  const grid = h("div", { class: "fb-compare", role: "radiogroup", "aria-labelledby": "fb-h1" });
  let lastPointer = 0;
  grid.addEventListener("pointerdown", () => { lastPointer = Date.now(); });
  grid.appendChild(h("div", { class: "fb-compare__captions", "aria-hidden": "true" }, h("span", { class: "fb-compare__corner" }), ...CAPTIONS.map((t) => h("span", { class: "fb-compare__caption" }, t))));
  POSTURES.forEach((p, i) => {
    const id = uid("pt");
    const descId = `${id}-d`;
    const input = h("input", { "data-dp": "setup.radio.paint-statement-true", class: "fb-tile__input", type: "radio", name: group, value: p.id, "aria-describedby": descId }) as HTMLInputElement;
    input.id = id;
    input.checked = choice === p.id;
    radios.push(input);
    const title = h("span", { class: "fb-tile__title" }, p.label);
    titles.set(p.id, title);
    const cells = CELLS[p.id];
    const face = h(
      "label",
      { class: "fb-tile__face fb-compare__face", for: id },
      h("span", { class: "fb-compare__top" }, h("span", { class: "fb-tile__mark", "aria-hidden": "true" }, svgIcon(ICON_CHECK, { size: 12 })), title, h("span", { class: "fb-tile__chosen", "aria-hidden": "true" }, "Chosen"), h("span", { class: "fb-tile__key", "aria-hidden": "true" }, String(i + 1))),
      // Each cell carries its caption too, shown only where the caption column is not (below 768 px, which
      // includes 200% zoom), so no consequence is ever read without its condition.
      ...cells.map((cell, r) => h("span", { class: `fb-compare__cell${r === 4 ? " fb-compare__cell--loss" : ""}`, "aria-hidden": "true" }, h("span", { class: "fb-compare__cap" }, CAPTIONS_SHORT[r] ?? ""), h("span", { class: "fb-compare__text" }, cell))),
      h("span", { id: descId, hidden: true }, CAPTIONS.map((cap, r) => `${cap}: ${cells[r]}`).join(" ")),
    );
    grid.appendChild(h("div", { class: "fb-tile fb-compare__tile" }, input, face));
    input.addEventListener("change", () => {
      if (!input.checked) return;
      if (choice !== p.id) ticked = false;
      choice = p.id;
      paintStatement(true);
      // On a narrow screen the statement and the tick are below the comparison: bring them up after a tap.
      // Not after a key press, so keyboard focus never scrolls out of view.
      if (Date.now() - lastPointer < 1000 && typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches) {
        statementHost.scrollIntoView({ block: "start", behavior: motionOK() ? "smooth" : "auto" });
      }
    });
  });
  // Number keys 1 and 2, scoped to the comparison itself.
  grid.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "1" && e.key !== "2")) return;
    const r = radios[Number(e.key) - 1];
    if (!r) return;
    e.preventDefault();
    r.focus();
    if (!r.checked) {
      r.checked = true;
      r.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  function paintStatement(reveal: boolean): void {
    if (choice === null) {
      statementHost.replaceChildren();
      c.refresh();
      return;
    }
    const p = POSTURES.find((x) => x.id === choice)!;
    const tick = checkRow({ label: POSTURE_TICK_LABEL, checked: ticked, onChange: (v) => { ticked = v; c.refresh(); } });
    const block = h(
      "div",
      { class: "fb-statement" },
      h("div", { class: "fb-statement__meta" }, h("code", { class: "fb-statement__ver" }, p.statement.version)),
      h("p", { class: "fb-statement__text" }, p.statement.text),
    );
    statementHost.replaceChildren(block, tick.el);
    if (reveal) enter(statementHost, { from: "below", distance: 8, duration: "--dur-2" });
    c.setPrimaryLabel(choice === "operational" ? "Confirm operational key" : "Confirm offline key only");
    c.refresh();
  }
  paintStatement(false);

  return {
    title: "Who can decrypt your backups?",
    lede: ["No default. ", externalLink("Read about both postures", DOCS)],
    body: [grid, statementHost, alert.el],
    hidePlan: true,
    primary: {
      label: choice === "operational" ? "Confirm operational key" : choice === "break-glass-only" ? "Confirm offline key only" : "Confirm posture",
      busyLabel: "Recording",
      busyText: "Your engine is recording your statement.",
      reason: () => (choice === null ? "Choose one first." : !ticked ? "Tick the statement." : null),
      run: async () => {
        if (choice === null) return;
        alert.set(null);
        // A posture change after keys were made in this tab invalidates them: the saved files no longer match.
        const held = currentCeremony();
        if (held !== null && (held.operational !== null) !== (choice === "operational")) {
          const ok = await confirmModal({
            title: "Change posture and make new keys?",
            body: "The keys in this tab were made for the other posture. Confirming clears them. Delete the files you saved, then make and save new ones.",
            confirmLabel: "Clear them and change",
            variant: "danger",
          });
          if (!ok) return;
          clearSensitiveState();
          m.update({ keysGenerated: false, keysSaved: false, possession: null, refusedFiles: [] });
        }
        c.setBusy(true);
        const r = await acknowledgePosture(choice);
        c.setBusy(false);
        if (!r.ok) return alert.set(r.error.message);
        c.flight(titles.get(choice) ?? null, "posture");
        c.next();
      },
    },
  };
}

// keysAlready is the Keys view for an engine that already holds keys: its posture is set on the engine, and
// the foundation's actions refuse to re-key from setup (they point to the Keys screen, which owns re-keying
// with its own warnings).
function keysAlready(c: QCtx): QView {
  return {
    title: "Your engine already holds keys",
    lede: ["Its posture is set. You can change it on the Keys screen after setup."],
    body: [h("p", { class: "fb-msg fb-msg--info" }, svgIcon(ICON_ALERT, { size: 16 }), h("span", { class: "fb-msg__text" }, "The Keys screen can replace your signer and your break-glass key. This makes new key files. The files that you saved before do not open new backups. Your configuration keys do not change."))],
    primary: { label: "Use these keys", run: () => c.next() },
    secondary: [textButton("Open the Keys screen", () => navigate("/keys"))],
  };
}
