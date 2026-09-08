// The key-vintage inventory panel of the Keys and break-glass screen.
//
// WHY IT EXISTS. A break-glass rotation writes only BREAK_GLASS_PUBLIC, so archives sealed before it stay
// wrapped to the old key and the engine cannot re-encrypt them. The Rotate tab has always WARNED about that
// ("Archives sealed before this rotation can only be opened by the old identity.key. Keep it."), but a warning
// is not a check: an owner who rotated and kept only the latest key had no in-product view telling them which
// vintages exist, which runs are stranded to a key the engine no longer holds, or how many runs a further
// re-key would stop verifying. The engine has computed that inventory (GET /admin/keys/vintages,
// admin/key-vintages.ts) and no console path reached it. This panel is that path.
//
// HONESTY, and why it is structural here. The engine reads every verdict off each run's SIGNATURE-VERIFIED
// root manifest, keylessly, so no recorded index can fabricate a false "safe". This panel must not undo that
// on render, so it refuses to state an all-clear it cannot support: historyReadOk false means the run list
// could not be enumerated (a zero count is "not read", never "nothing at stake") and truncated means older
// runs went uninspected this pass. Both are surfaced before any count, and neither is styled as a pass.
//
// NO-CUSTODY: the response carries PUBLIC dpr1:/edmldsa1: fingerprints, the engine's closed role names and
// run counts. There is no private half, seed or ciphertext in the shape, so no render of it can leak one.
//
// House style: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { badge } from "../../components/status.ts";
import { skeletonRows } from "../../components/feedback.ts";
import { blockError, sessionEnded } from "../../components/error-view.ts";
import { isUnauthorised } from "../../lib/errors.ts";
import { goSignedOut } from "../../lib/nav.ts";
import { ICON_REFRESH } from "../../lib/icons.ts";
import type { EngineClient } from "../../api.ts";
import type { KeyVintageInventory, KeyVintageRollup, StrandedVintage } from "../../lib/api/types.ts";

// VINTAGE_HEADING is the panel's accessible name. It is exported so the console's own tests pin the
// same string, rather than each guessing at it.
export const VINTAGE_HEADING = "Which key opens which vintage";

// shortFp trims a fingerprint for a dense row while keeping enough to tell two vintages apart. The full
// value is kept in the title attribute and in the row's text for copy, so nothing is hidden, only shortened.
export function shortFp(fingerprint: string): string {
  const body = fingerprint.includes(":") ? fingerprint.slice(fingerprint.indexOf(":") + 1) : fingerprint;
  return body.length <= 16 ? fingerprint : `${fingerprint.slice(0, fingerprint.indexOf(":") + 1)}${body.slice(0, 12)}`;
}

// vintageSummary is the one-sentence verdict, computed as a PURE function of the inventory so it is unit
// tested without a DOM and so the honesty rules are in one readable place rather than scattered through
// render code. The order is deliberate: an unread history and a truncated scan both outrank a zero count,
// because a count derived from an incomplete read must never be presented as an all-clear.
export function vintageSummary(inv: KeyVintageInventory): { tone: "ok" | "warn" | "info"; title: string; detail: string } {
  if (!inv.historyReadOk) {
    return {
      tone: "warn",
      title: "The run history could not be read",
      detail: "The engine could not enumerate your runs, so this inventory is not a verdict. The counts below are what it managed to read, not the whole estate. Try again, and if it persists, generate a support pack.",
    };
  }
  if (inv.stranded.runCount > 0) {
    return {
      tone: "warn",
      title: `${inv.stranded.runCount} ${inv.stranded.runCount === 1 ? "run is" : "runs are"} stranded to a key your engine no longer holds`,
      detail: "Those archives can only be opened by the identity.key for the vintage they were sealed under. Keep that file; without it those runs cannot be restored, and no rotation can bring them back.",
    };
  }
  if (inv.truncated || inv.stranded.unknownCount > 0) {
    return {
      tone: "info",
      title: "No stranded runs found in what was inspected",
      detail: "This pass did not read every run, so it cannot say nothing older is stranded. Keep every identity.key you have generated until a complete pass says otherwise.",
    };
  }
  return {
    tone: "ok",
    title: "Every run read back is openable by a key your engine currently holds",
    detail: "No archive inspected this pass is stranded to a retired key. Keep your identity.key files regardless: they are the only way in if the engine is lost.",
  };
}

// renderKeyVintages builds the panel. It fetches on mount (the inventory is a read the operator came here
// for, not a click away) and offers a re-read, because a rotation performed in another tab changes it.
export function renderKeyVintages(engine: EngineClient): HTMLElement {
  const card = h("section", { class: "card measure", "aria-labelledby": "keys-vintages-h" });
  const header = h("div", { class: "card__header" });
  header.appendChild(h("h3", { class: "card__title", id: "keys-vintages-h" }, VINTAGE_HEADING));
  const refresh = h(
    "button",
    { "data-dp": "keys.button.refresh", class: "btn btn--secondary btn--sm", type: "button" },
    svgIcon(ICON_REFRESH, { size: 14 }),
    "Re-read",
  ) as HTMLButtonElement;
  header.appendChild(refresh);
  card.appendChild(header);
  card.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "Read from each run's signed manifest, without any private key. It lists the keys your archives are wrapped to, so you can tell which identity.key you still need. ",
      h(
        "a",
        { class: "field__doc linklike", href: "https://docs.downpipes.io/concepts/rotating-your-keys#rotating-the-break-glass-key-two-vintages", target: "_blank", rel: "noreferrer noopener" },
        "How rotation creates two vintages",
      ),
    ),
  );

  const host = h("div", { style: "display:grid;gap:var(--space-4)" });
  card.appendChild(host);

  function load(): void {
    refresh.disabled = true;
    host.replaceChildren(skeletonRows(3));
    void engine.getKeyVintages()
      .then((inv) => {
        refresh.disabled = false;
        host.replaceChildren(inventoryBody(inv));
      })
      .catch((err: unknown) => {
        refresh.disabled = false;
        // A 401 is an invalid session, not an engine fault: route to the signed-out screen rather than
        // rendering a retry the operator cannot succeed at.
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE: the vintage inventory is a skeleton until this replaces it.
          host.replaceChildren(sessionEnded(() => load()));
          return goSignedOut();
        }
        host.replaceChildren(blockError(err, () => load()));
      });
  }

  refresh.addEventListener("click", () => load());
  load();
  return card;
}

// inventoryBody renders the loaded inventory: the verdict first, then the per-vintage rows, then the
// signer-continuity line the re-key surface needs.
function inventoryBody(inv: KeyVintageInventory): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-4)" });
  const verdict = vintageSummary(inv);
  wrap.appendChild(
    h(
      "div",
      { style: "display:grid;grid-template-columns:auto 1fr;gap:var(--space-3);align-items:start" },
      h("span", { class: `dot dot--${verdict.tone}`, "aria-hidden": "true", style: "margin-top:6px;flex:none" }),
      h("div", h("b", { style: "display:block" }, verdict.title), h("span", { class: "field__hint" }, verdict.detail)),
    ),
  );

  if (inv.vintages.length === 0) {
    wrap.appendChild(
      h(
        "p",
        { class: "field__hint" },
        inv.historyReadOk
          ? "No archive read back this pass named a recipient key, so there is no vintage to list yet. A first successful run creates one."
          : "No vintage could be listed, because the run history did not read.",
      ),
    );
  } else {
    const list = h("ul", { style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-3)" });
    for (const v of inv.vintages) list.appendChild(vintageRow(v));
    wrap.appendChild(list);
  }

  if (inv.stranded.byVintage.length > 0) {
    wrap.appendChild(h("h4", { style: "font-size:var(--text-md);margin:0" }, "Vintages you still need the old key for"));
    const list = h("ul", { style: "list-style:none;padding:0;margin:0;display:grid;gap:var(--space-2)" });
    for (const s of inv.stranded.byVintage) list.appendChild(strandedRow(s));
    wrap.appendChild(list);
  }

  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      `Read back and verified: ${inv.readableRunCount} of ${inv.okRunCount} completed runs.`,
      inv.stranded.unknownCount > 0 ? ` ${inv.stranded.unknownCount} could not be attributed to a key and are not counted either way.` : "",
      inv.truncated ? " This pass stopped short of the oldest runs." : "",
    ),
  );

  // Signer continuity is a separate question from which key OPENS an archive: re-keying the signer stops
  // the console verifying older receipts even when every archive is still openable. Both counts are shown
  // on the same surface, because an owner reading only one of them draws the wrong conclusion.
  wrap.appendChild(
    h(
      "p",
      { class: "field__hint" },
      inv.signer.brokenRunCount > 0
        ? `Signature check: ${inv.signer.currentRunCount} runs verify under your current signer and ${inv.signer.brokenRunCount} do not, so those were signed before a signer change.`
        : `Signature check: all ${inv.signer.currentRunCount} runs read back verify under your current signer. Re-keying the signer would stop that.`,
    ),
  );
  return wrap;
}

function vintageRow(v: KeyVintageRollup): HTMLElement {
  const li = h("li", { style: "display:grid;grid-template-columns:1fr auto;gap:var(--space-3);align-items:center" });
  const left = h("div");
  const fp = h("code", { class: "mono", style: "word-break:break-all", title: v.fingerprint });
  fp.textContent = shortFp(v.fingerprint); // a public fingerprint, and textContent never parses markup
  left.appendChild(fp);
  left.appendChild(
    h(
      "div",
      { class: "field__hint" },
      `${v.role} key, ${v.runCount} ${v.runCount === 1 ? "run" : "runs"}`,
      v.isCurrent ? " (your engine holds this key)" : " (your engine does not hold this key; only your saved identity.key opens these)",
    ),
  );
  li.appendChild(left);
  li.appendChild(v.isCurrent ? badge("ok", "Current") : badge("warn", "Old vintage"));
  return li;
}

function strandedRow(s: StrandedVintage): HTMLElement {
  const li = h("li", { class: "field__hint" });
  const fp = h("code", { class: "mono", title: s.fingerprint });
  fp.textContent = shortFp(s.fingerprint);
  li.appendChild(fp);
  li.appendChild(h("span", ` ${s.role}: ${s.runCount} ${s.runCount === 1 ? "run" : "runs"} need this key's identity.key`));
  return li;
}
