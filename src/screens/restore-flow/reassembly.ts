// The in-browser Shamir M-of-N reassembly CARD, factored out of recover-key.ts so the SAME
// reviewed reconstruction is reused by both the standalone /restore/recover-key screen (reconstruct-and-
// download) and the in-console break-glass restore panel (break-glass.ts), which reassembles a split key to
// decap a run's per-run master. There is no new cryptography and no new engine route: every primitive here
// already ships and is already unit-tested (combine + verifyWrappingKey in ../../lib/shamir.ts, parseShareFile
// + parseEnvelopeFile in ../../lib/custody-files.ts, decrypt in ../../lib/envelope.ts, parseIdentityFile in
// ../../lib/keydecap.ts, all pure and network-free).
//
// NO-CUSTODY: every share, the reconstructed wrapping key, the decrypted identity.key text and (in the
// break-glass caller) the parsed private are produced and held ONLY in this browser, in this render's own
// closure. This card takes NO EngineClient and calls no engine method anywhere in its body: it CANNOT reach
// the network. What the CALLER does with the recovered identity.key text (offer it as a local download, or
// parse it to decap a per-run master for a restore) is the caller's concern and is passed in via onRecovered;
// the reconstruction itself never leaves the browser and the M-of-N threshold is never weakened (combine()
// needs the real quorum of correct shares; nothing here lets the browser or the engine lower that bar).
//
// House rules: Australian English, no em dashes, no rule-of-three, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { field } from "../../components/field.ts";
import { toast } from "../../components/toast.ts";
import { spinnerLine, setBtnBusy, errMessage } from "../../components/custody-step-helpers.ts";
import { deliverFile } from "../../lib/file-delivery.ts";
import { ICON_KEYS, ICON_TRASH, ICON_CHEVRON_RIGHT, ICON_REFRESH } from "../../lib/icons.ts";
import { combine, verifyWrappingKey } from "../../lib/shamir.ts";
import { parseShareFile, parseEnvelopeFile, type ShareFileFields, type EnvelopeFileFields } from "../../lib/custody-files.ts";
import { decrypt } from "../../lib/envelope.ts";
import { parseIdentityFile, type HybridRecipientPrivate } from "../../lib/keydecap.ts";

// A short, clearly-illustrative (never functional) example of a share file's shape, for the paste
// textarea's placeholder. The checksum/share tokens are truncated nonsense, not real base64url output.
const SHARE_PASTE_PLACEHOLDER = "downpipe-shamir-share-v1\nindex 2\nn 5\nthreshold 3\nchecksum kf39Qg\nshare AbCdEf...";

// ReassemblyCard is the handle a caller mounts: the card element plus a teardown that best-effort zeros every
// mutable secret buffer this render still holds and drops the references (for nav-away / panel teardown).
export interface ReassemblyCard {
  el: HTMLElement;
  teardown(): void;
}

// wipeOnDisconnect runs `wipe` once, when `el` leaves the document.
//
// WHY THIS EXISTS AS A HELPER RATHER THAN A FOURTH COPY. Four mount sites already carried this
// MutationObserver-on-disconnect block inline (recover-key.ts, attend.ts's setup form, and both branches of
// restore-flow.ts), and every site that DID NOT carry it was a site where a reassembly card's secrets
// survived navigation. The pattern is the load-bearing half of the custody promise, so it belongs in the
// module that owns the wipe contract, where a new caller finds it beside the teardown it is meant to call.
//
// It closes the specific hole that the router's own exit does not. app.ts's afterEach calls
// closeAllOverlays(), and dialog.ts states in its own comment that it tears every overlay down WITHOUT
// invoking their onClose callbacks (deliberately: an onClose that navigates would fight the navigation
// already in progress). Both halves are correct alone. Together they mean a modal or panel that hangs its
// wipe on a dismiss callback is never wiped by navigating away. A disconnect observer has no such conflict,
// because it only zeroes buffers: it never navigates, so it cannot fight the navigation that triggered it.
//
// Best-effort, exactly as the sites it replaces already said: a hard tab close cannot run JS to wipe, and
// this settles which code runs rather than what remains in the browser's heap afterwards.
//
// The everConnected guard means a DOM mutation BEFORE `el` is mounted never fires a premature wipe that
// would then stop observing. Where MutationObserver is absent (a minimal test DOM) this is a no-op rather
// than a throw, and the caller's explicit teardown path is unaffected.
export function wipeOnDisconnect(el: HTMLElement, wipe: () => void): void {
  if (typeof MutationObserver !== "function") return;
  let everConnected = false;
  const observer = new MutationObserver(() => {
    if (el.isConnected) {
      everConnected = true;
      return;
    }
    if (everConnected) {
      wipe();
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

// ReassemblyOptions parameterise the one card for its two callers.
export interface ReassemblyOptions {
  // onRecovered fires on a SUCCESSFUL reconstruct with the PARSED private, or null when the recovered file
  // is not a standard identity.key.
  //
  // It used to hand back the recovered TEXT, and every consumer then re-parsed it. That created a second
  // immutable JS string of the customer's break-glass key in each caller, which nothing can overwrite, on
  // top of the one this card already holds. Handing the parsed key back instead removes the copy entirely:
  // this card parses once, to decide isIdentity, and simply gives the caller what it already has.
  //
  // The private is handed synchronously and the caller owns it from that moment: it must zero both halves
  // when done (they are views over one 96-byte decode, so zeroing both wipes it whole) and must drop it on
  // onInvalidated, because a key derived from superseded inputs is stale.
  onRecovered?: (identity: HybridRecipientPrivate | null) => void;
  // onInvalidated fires whenever the loaded inputs change (a share added/removed, a new ciphertext, reset, or
  // teardown), so a caller holding a value DERIVED from a prior reconstruct (e.g. a decapped per-run master)
  // drops it. It is the caller's signal that any previously-recovered key no longer corresponds to what is
  // loaded now.
  onInvalidated?: () => void;
  // showDownload renders the local "Download identity.key" button (the standalone recover-key screen). The
  // break-glass panel leaves it false: there the recovered key feeds a decap in the same tab, never a file.
  showDownload?: boolean;
}


// zero best-effort clears a Uint8Array in place. Best-effort only: the ORIGINAL file text a FileReader or a
// pasted textarea produced is an immutable JS string that cannot be wiped, and TextDecoder/base64 decoding
// make uncontrolled intermediate copies along the way. This is the same reality the shipped attend runner
// already lives with (attend.ts:122,235,249); it is stated here rather than implied.
function zero(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0);
}

function downloadRecovered(name: string, content: string): boolean {
  // "key-ceremony" is the existing, shipped surface tag for identity.key downloads on the Keys screen
  // family, so reusing it here needs no new ClientDiagSurface member (which would in turn need an identical
  // addition on the engine's twin vocabulary to avoid failing the build).
  const delivered = deliverFile(name, content, "text/plain", "key-ceremony");
  if (!delivered) {
    toast({ tone: "warn", message: `Your browser did not save ${name}. Check its download settings, then use Download again.` });
  }
  return delivered;
}

// sharesDocLink / ciphertextDocLink are the group-level external doc links for the two raw file inputs (a raw
// control cannot ride a field()'s doc option; see attend.ts's keyDocLink() precedent). Each href is a literal
// string ON ONE LINE, including its anchor, so the doc-link gate resolves it against the real, existing
// headings on docs/src/content/docs/concepts/choosing-your-key-custody.mdx.
function sharesDocLink(): HTMLElement {
  return h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/concepts/choosing-your-key-custody#what-a-single-share-reveals", target: "_blank", rel: "noreferrer noopener" },
    "Learn more",
    svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
  );
}
function ciphertextDocLink(): HTMLElement {
  return h(
    "a",
    { class: "field__doc linklike", href: "https://docs.downpipes.io/concepts/choosing-your-key-custody#how-the-split-works", target: "_blank", rel: "noreferrer noopener" },
    "Learn more",
    svgIcon(ICON_CHEVRON_RIGHT, { size: 13 }),
  );
}

// renderReassemblyCard builds the "load your shares + the encrypted key file, reconstruct locally" card. It
// takes NO EngineClient: the absence is deliberate and load-bearing, the strongest signal that this card
// cannot reach the network. What happens to the recovered key is the caller's concern (onRecovered).
// findGoodSubset locates a threshold-sized subset of shares that actually reconstructs the key, and then
// classifies every remaining share against it. It exists because combine() interpolates over whatever it is
// given and has no error detection, so a single bad share in an otherwise-sufficient set yields a wrong key
// and an operator with no way to tell which share was at fault.
//
// Cost is bounded by the splitter's own cap of 16 shares: C(16,8) = 12,870 combines of 32 bytes, each
// followed by a checksum compare, which is milliseconds. Returns null when no subset verifies, which means
// more than one share is wrong or the ciphertext does not belong to these shares at all.
//
// Every wrapping key tried and rejected is zeroed before the next attempt; only the winning one is returned,
// and the caller zeroes that once it has decrypted.
export function findGoodSubset(group: ShareFileFields[], checksum: Uint8Array): { wrappingKey: Uint8Array; good: ShareFileFields[]; bad: ShareFileFields[] } | null {
  const t = group[0]?.threshold ?? 0;
  if (t < 2 || group.length < t) return null;

  // tryCombine returns the wrapping key when this exact subset verifies, else null (zeroing as it goes).
  const tryCombine = (subset: ShareFileFields[]): Uint8Array | null => {
    let key: Uint8Array;
    try {
      key = combine(subset.map((f) => f.share));
    } catch {
      return null; // a structural refusal (duplicate or zero index, wrong length): this subset is simply not usable
    }
    if (verifyWrappingKey(key, checksum)) return key;
    zero(key);
    return null;
  };

  // Walk subsets of exactly the threshold size, in index order so the outcome is deterministic and a
  // support engineer can reproduce what the operator saw.
  const ordered = [...group].sort((a, b) => a.index - b.index);
  const chosen: ShareFileFields[] = [];
  let winner: { key: Uint8Array; subset: ShareFileFields[] } | null = null;
  const walk = (start: number): void => {
    if (winner) return;
    if (chosen.length === t) {
      const key = tryCombine(chosen);
      if (key) winner = { key, subset: [...chosen] };
      return;
    }
    for (let i = start; i < ordered.length && !winner; i++) {
      chosen.push(ordered[i]!);
      walk(i + 1);
      chosen.pop();
    }
  };
  walk(0);
  if (!winner) return null;
  const w: { key: Uint8Array; subset: ShareFileFields[] } = winner;

  // Classify the leftovers: swap each into the known-good subset in place of one member. A share that still
  // verifies belongs to this split; one that does not is wrong or altered. O(n) further combines.
  const good = [...w.subset];
  const bad: ShareFileFields[] = [];
  for (const f of ordered) {
    if (w.subset.includes(f)) continue;
    const probe = [f, ...w.subset.slice(0, t - 1)];
    const key = tryCombine(probe);
    if (key) {
      zero(key);
      good.push(f);
    } else {
      bad.push(f);
    }
  }
  return { wrappingKey: w.key, good, bad };
}

export function renderReassemblyCard(opts: ReassemblyOptions = {}): ReassemblyCard {
  // ---- closure state: every byte below lives ONLY here, is never uploaded, and is best-effort zeroed on
  // reset, on a failed reconstruct (the wrapping key), and on teardown / navigation away. -----------------
  // Keyed by CLUSTER then index, not index alone. Two shares from different splits can carry the same
  // index, and the old single-reference model refused the second one outright, so a stray share loaded
  // FIRST locked out every correct share after it and blamed the correct ones in the message. Worse, the
  // file picker fires an independent async FileReader per file, so completion order is not selection
  // order: the same four files could be accepted or rejected differently on two consecutive attempts,
  // which is not something a support engineer can reproduce.
  const shares = new Map<string, ShareFileFields>();
  // clusterKeyOf identifies the split a share belongs to. Shares agreeing on all three of n, threshold and
  // the public checksum came from one split; anything else is a different split and must not be silently
  // interleaved with it.
  const clusterKeyOf = (f: ShareFileFields): string => `${f.n}|${f.threshold}|${hexOf(f.checksum)}`;
  const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  // clusters groups the loaded shares by split, largest first, so the UI and the reconstruct both work
  // from the set the operator most likely intends rather than from whichever file happened to land first.
  const clusters = (): ShareFileFields[][] => {
    const byKey = new Map<string, ShareFileFields[]>();
    for (const f of shares.values()) {
      const k = clusterKeyOf(f);
      const arr = byKey.get(k);
      if (arr) arr.push(f);
      else byKey.set(k, [f]);
    }
    return [...byKey.values()].sort((a, b) => b.length - a.length);
  };
  const mainCluster = (): ShareFileFields[] => clusters()[0] ?? [];
  let envelope: EnvelopeFileFields | null = null;
  let recoveredBytes: Uint8Array | null = null;

  // grid-template-columns is explicit (minmax(0, 1fr)) rather than left as the implicit bare
  // "auto" column display:grid alone gives you. An auto column's floor is the AUTOMATIC MINIMUM
  // SIZE of the widest row placed in it (each row's own min-width:auto default), and on a
  // Linux font stack that floor can run wider than it does on macOS, letting the card escape its own
  // content box at narrow widths. minmax(0, 1fr) pins the column's minimum to 0
  // instead, the same fix already used in this codebase for the identical shape at
  // /access/roles/builder (minmax(360px, 1fr) -> minmax(min(360px, 100%), 1fr)).
  // A row whose own content still cannot shrink wraps or scrolls inside its cell; it no longer
  // forces every other row in this single-column card wide along with it.
  const card = h("section", { class: "card", style: "display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-4)" });
  card.appendChild(h("h3", { class: "card__title" }, "Load your shares and the encrypted key file"));

  // ---- 1. shares: file-picker + paste, feeding the SAME in-memory quorum ---------------------------------
  const sharesErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const sharesStatus = h("p", { class: "field__hint", role: "status", "aria-live": "polite" }, "No shares loaded yet.");
  const sharesListHost = h("div", { style: "display:grid;gap:var(--space-1)" });

  const reconstructBtn = h(
    "button",
    { "data-dp": "restore-flow.button.reconstruct", class: "btn btn--primary", type: "button", disabled: true },
    svgIcon(ICON_KEYS, { size: 14 }),
    "Reconstruct in this browser",
  ) as HTMLButtonElement;
  const downloadBtn = h(
    "button",
    { "data-dp": "restore-flow.button.download", class: "btn btn--secondary", type: "button", disabled: true },
    "Download identity.key",
  ) as HTMLButtonElement;
  const resultHost = h("div", { role: "status", "aria-live": "polite" });

  // invalidateResult clears any previously-reconstructed bytes whenever the loaded inputs change, so Download
  // can never offer bytes that no longer correspond to what is currently loaded, AND signals the caller
  // (onInvalidated) to drop anything it derived from a prior reconstruct (e.g. a decapped per-run master).
  const invalidateResult = (): void => {
    zero(recoveredBytes);
    recoveredBytes = null;
    downloadBtn.disabled = true;
    resultHost.replaceChildren();
    opts.onInvalidated?.();
  };

  const currentThreshold = (): number | null => mainCluster()[0]?.threshold ?? null;
  const currentN = (): number | null => mainCluster()[0]?.n ?? null;

  const refreshSharesUI = (): void => {
    const t = currentThreshold();
    const n = currentN();
    const groups = clusters();
    const main = groups[0] ?? [];
    // The shortfall, not just the count. "2 of 3 loaded" leaves the operator working out how many more to
    // fetch, in front of the custodians they had to assemble to get this far.
    const short = t !== null ? t - main.length : 0;
    sharesStatus.textContent =
      shares.size === 0
        ? "No shares loaded yet. The share files themselves say how many are needed."
        : t === null || n === null
          ? `${shares.size} share(s) loaded.`
          : short > 0
            ? `${main.length} of ${t} loaded. ${short} more share${short === 1 ? "" : "s"} needed.`
            : `${main.length} of ${t} loaded (any ${t} of the ${n} total reconstruct). Ready to reconstruct.`;

    const rows: HTMLElement[] = [];
    // More than one split loaded: say so, rather than silently reconstructing from whichever is larger.
    if (groups.length > 1) {
      const others = groups.slice(1).reduce((a, g) => a + g.length, 0);
      rows.push(
        h("p", { class: "field__error", style: "margin:0" },
          `These shares come from ${groups.length} different splits. ${main.length} agree with each other and ${others} do not. Remove the ones that do not belong to the split you are recovering.`),
      );
    }
    for (const group of groups) {
      const belongs = group === main;
      for (const f of [...group].sort((a, b) => a.index - b.index)) {
        const row = h("div", { style: "display:flex;align-items:center;gap:var(--space-2)" });
        row.appendChild(h("span", belongs ? `Share ${f.index} loaded` : `Share ${f.index} loaded (a different split)`));
        const removeShareBtn = h(
          "button",
          { "data-dp": "restore-flow.button.remove-share", class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Remove share ${f.index}` },
          svgIcon(ICON_TRASH, { size: 13 }),
        );
        removeShareBtn.addEventListener("click", () => {
          shares.delete(`${clusterKeyOf(f)}#${f.index}`);
          refreshSharesUI();
          refreshReconstructEnabled();
          invalidateResult();
        });
        row.appendChild(removeShareBtn);
        rows.push(row);
      }
    }
    sharesListHost.replaceChildren(...rows);
  };

  const refreshReconstructEnabled = (): void => {
    const t = currentThreshold();
    reconstructBtn.disabled = !(envelope !== null && t !== null && mainCluster().length >= t);
  };

  // addShare validates a newly parsed share against any already-loaded ones (the same split: n, threshold and
  // the public checksum must all agree) before accepting it. A mismatch is refused with a content-free,
  // kind-only reason (never a byte, never which field did not match). Re-adding a share already loaded at the
  // same index simply replaces it: no error.
  const addShare = (parsed: ShareFileFields): { ok: true } | { ok: false; reason: string } => {
    shares.set(`${clusterKeyOf(parsed)}#${parsed.index}`, parsed);
    refreshSharesUI();
    refreshReconstructEnabled();
    invalidateResult();
    return { ok: true };
  };

  // 1a. File-picker: multiple share files at once, each read locally with FileReader and never uploaded.
  const sharesFileInput = h("input", {
    id: "recover-shares",
    type: "file",
    multiple: true,
    accept: ".txt,text/plain",
    "aria-label": "Select your share files",
  }) as HTMLInputElement;
  sharesFileInput.addEventListener("change", () => {
    const files = sharesFileInput.files ? [...sharesFileInput.files] : [];
    sharesFileInput.value = ""; // allow re-selecting the identical file later (e.g. after Remove)
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = parseShareFile(typeof reader.result === "string" ? reader.result : "");
          const res = addShare(parsed);
          if (res.ok) {
            sharesErr.hidden = true;
          } else {
            sharesErr.textContent = res.reason;
            sharesErr.hidden = false;
          }
        } catch (e) {
          sharesErr.textContent = errMessage(e);
          sharesErr.hidden = false;
        }
      };
      reader.onerror = () => {
        sharesErr.textContent = "Could not read that file.";
        sharesErr.hidden = false;
      };
      reader.readAsText(file);
    }
  });

  // 1b. Paste: the full text of ONE share file at a time, fed to the SAME parseShareFile as the file picker,
  // so an operator who received a share as pasted text never has to save it to disk first just to load it.
  const pasteField = field({
    id: "recover-shares-paste",
    label: "Or paste one share's full text",
    kind: "textarea",
    placeholder: SHARE_PASTE_PLACEHOLDER,
    hint: "Paste the entire contents of one downpipe-shamir-share-v1 file (not just the token), then add it.",
    doc: { href: "https://docs.downpipes.io/concepts/choosing-your-key-custody", anchor: "what-a-single-share-reveals" },
  });
  const addShareBtn = h(
    "button",
    { "data-dp": "restore-flow.button.add-share", class: "btn btn--secondary btn--sm", type: "button" },
    "Add this share",
  ) as HTMLButtonElement;
  addShareBtn.addEventListener("click", () => {
    const text = pasteField.control.value;
    if (text.trim() === "") {
      pasteField.setError("Paste a share's full text first.");
      return;
    }
    try {
      const parsed = parseShareFile(text);
      const res = addShare(parsed);
      if (res.ok) {
        pasteField.clearError();
        pasteField.control.value = "";
        sharesErr.hidden = true;
      } else {
        pasteField.setError(res.reason);
      }
    } catch (e) {
      pasteField.setError(errMessage(e));
    }
  });

  card.appendChild(
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "recover-shares" }, "Your share files"),
      sharesFileInput,
      h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "Select one or more downpipe-shamir-share-v1 files. Each is read here and never uploaded."),
      sharesDocLink(),
    ),
  );
  card.appendChild(h("div", { style: "display:flex;gap:var(--space-2);align-items:flex-end;flex-wrap:wrap" }, pasteField.el, addShareBtn));
  card.appendChild(sharesErr);
  card.appendChild(sharesStatus);
  card.appendChild(sharesListHost);

  // ---- 2. the encrypted key file (identity.key.enc): file-picker only, one file --------------------------
  const ciphertextErr = h("p", { class: "field__error", role: "alert", hidden: true });
  const ciphertextStatus = h("p", { class: "field__hint", role: "status", "aria-live": "polite" }, "No encrypted key file loaded yet.");
  const ciphertextFileInput = h("input", {
    id: "recover-ciphertext",
    type: "file",
    accept: ".enc,.txt,text/plain",
    "aria-label": "Select the encrypted key file (identity.key.enc)",
  }) as HTMLInputElement;
  ciphertextFileInput.addEventListener("change", () => {
    const file = ciphertextFileInput.files?.[0];
    ciphertextFileInput.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        envelope = parseEnvelopeFile(typeof reader.result === "string" ? reader.result : "");
        ciphertextErr.hidden = true;
        ciphertextStatus.textContent = "Encrypted key file loaded.";
        refreshReconstructEnabled();
        invalidateResult();
      } catch (e) {
        envelope = null;
        ciphertextErr.textContent = errMessage(e);
        ciphertextErr.hidden = false;
        ciphertextStatus.textContent = "No encrypted key file loaded yet.";
        refreshReconstructEnabled();
        // A stale prior result must never survive an input change, even a failed one: without this, a successful reconstruct followed by loading a DIFFERENT, unparseable
        // ciphertext left Download enabled and still serving the PREVIOUS ciphertext's bytes.
        invalidateResult();
      }
    };
    reader.onerror = () => {
      envelope = null;
      ciphertextErr.textContent = "Could not read that file.";
      ciphertextErr.hidden = false;
      refreshReconstructEnabled();
      invalidateResult();
    };
    reader.readAsText(file);
  });
  card.appendChild(
    h(
      "div",
      { class: "field", style: "margin-top:var(--space-2)" },
      h("label", { class: "field__label", for: "recover-ciphertext" }, "The encrypted key file (identity.key.enc)"),
      ciphertextFileInput,
      h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "Select the single identity.key.enc file. It is read here and never uploaded."),
      ciphertextDocLink(),
    ),
  );
  card.appendChild(ciphertextErr);
  card.appendChild(ciphertextStatus);

  // ---- 3. Reconstruct: combine -> verify -> authenticated decrypt, each stage mapped to one friendly,
  // content-free outcome (never which share, never a byte). ------------------------------------------------
  reconstructBtn.addEventListener("click", () => void doReconstruct());

  async function doReconstruct(): Promise<void> {
    const t = currentThreshold();
    if (!envelope || t === null || shares.size < t) return;
    setBtnBusy(reconstructBtn, true, "Reconstructing");
    resultHost.replaceChildren(spinnerLine("Reconstructing in this browser. Nothing is being sent."));
    downloadBtn.disabled = true;

    const group = mainCluster();
    const checksum = group[0]!.checksum;

    // a. combine() has NO error detection of its own: a bad or short share set silently yields a WRONG key
    // (shamir.ts). It also interpolates over every share it is handed, so passing all of them meant ONE bad
    // share defeated an otherwise-good quorum, and the operator was told to "try removing a share" with no
    // idea which. That is up to C(n,t) blind attempts, performed in front of assembled custodians.
    //
    // verifyWrappingKey is a cheap local check, and n is capped at 16 by the splitter, so the worst case here
    // is C(16,8) = 12,870 interpolations of 32 bytes. Search subsets of exactly the threshold size until one
    // verifies, then identify the culprits by testing each remaining share against that known-good subset.
    // The operator gets a named answer instead of a search.
    const found = findGoodSubset(group, checksum);
    if (found === null) {
      setBtnBusy(reconstructBtn, false, "Reconstruct in this browser");
      resultHost.replaceChildren(
        h("p", { class: "field__error" },
          "No combination of the shares you loaded reconstructs this key. Either one of them belongs to a different split, or more than one has been altered. Check each share against the copy its custodian holds, and confirm identity.key.enc is the file that was produced with them."),
      );
      return;
    }
    const { wrappingKey, good, bad } = found;

    let plaintext: Uint8Array;
    try {
      // c. The authoritative check: authenticated AES-256-GCM decrypt (envelope.ts). A wrong key throws on the
      // GCM tag rather than returning corrupt bytes, so a decrypt success is a true reconstruction proof.
      plaintext = await decrypt(envelope.ciphertext, envelope.iv, wrappingKey);
    } catch {
      zero(wrappingKey);
      setBtnBusy(reconstructBtn, false, "Reconstruct in this browser");
      resultHost.replaceChildren(
        h(
          "p",
          { class: "field__error" },
          "These shares do not reconstruct a valid key. One may be wrong or mistyped, or you may be short of the threshold. Try removing a share and reconstructing again.",
        ),
      );
      return;
    }
    zero(wrappingKey); // the wrapping key's job ends the instant the decrypt above returns; never needed again

    // Name the shares that did not belong, rather than reconstructing quietly and leaving a bad share in
    // circulation for the next recovery to trip over.
    if (bad.length > 0) {
      const list = bad.map((f) => f.index).sort((a, b) => a - b).join(", ");
      const used = good.map((f) => f.index).sort((a, b) => a - b).join(", ");
      resultHost.appendChild(
        h("p", { class: "field__hint", style: "margin-top:var(--space-2)" },
          `Reconstructed from shares ${used}. Share${bad.length === 1 ? "" : "s"} ${list} do${bad.length === 1 ? "es" : ""} not belong to this split or ha${bad.length === 1 ? "s" : "ve"} been altered, so ${bad.length === 1 ? "it was" : "they were"} left out. Your key is correct; check ${bad.length === 1 ? "that share" : "those shares"} with the custodian before relying on ${bad.length === 1 ? "it" : "them"} again.`),
      );
    }

    // d. A downstream shape check only, deliberately decoupled from the decrypt success above (which is already
    // the proof reconstruction worked): confirms whether the recovered bytes are a standard identity.key, purely
    // to word the outcome honestly and to tell the caller whether onRecovered's text is a usable identity.key.
    // Parse ONCE. The result decides the wording below and is what the caller receives, so neither this card
    // nor any consumer needs to decode the key to a string a second time.
    const text = new TextDecoder().decode(plaintext);
    let parsed: HybridRecipientPrivate | null = null;
    try {
      parsed = parseIdentityFile(text);
    } catch {
      parsed = null;
    }
    const isIdentity = parsed !== null;

    recoveredBytes = plaintext;
    downloadBtn.disabled = !opts.showDownload || false;
    setBtnBusy(reconstructBtn, false, "Reconstruct in this browser");
    resultHost.replaceChildren(
      h(
        "p",
        { class: "field__hint", style: "display:flex;gap:var(--space-2);align-items:flex-start;color:var(--ok, inherit)" },
        h("span", { style: "flex:none;margin-top:1px" }, svgIcon(ICON_KEYS, { size: 14 })),
        h(
          "span",
          isIdentity
            ? opts.showDownload
              ? "Reconstructed a valid identity.key in this browser. Download it below."
              : "Reconstructed a valid identity.key in this browser."
            : "Reconstructed a file in this browser, but it is not in the standard identity.key shape.",
        ),
      ),
    );
    // Hand the PARSED private to the caller (the break-glass panel decaps a run master with it; the
    // standalone screen leaves this undefined and offers Download instead). Fired AFTER recoveredBytes is
    // set so a caller that re-enters synchronously sees a consistent card.
    opts.onRecovered?.(parsed);
    toast({ message: "Reconstructed in this browser. Nothing was sent." });
  }

  // ---- 4. Download (standalone screen only): the recovered bytes offered as a local file, exactly as
  // decrypted (a byte-for-byte round trip of the original identity.key text), never re-derived or re-encoded.
  downloadBtn.addEventListener("click", () => {
    if (!recoveredBytes) return;
    downloadRecovered("identity.key", new TextDecoder().decode(recoveredBytes));
  });

  // wipe best-effort zeros every mutable secret buffer this render still holds, then drops the references and
  // signals the caller to drop anything it derived. Shared by Reset (with a UI refresh + toast) and teardown
  // (silent, for nav-away). The share bodies and the envelope's ciphertext/iv are real Uint8Arrays (unlike the
  // immutable-string caveat on the ORIGINAL file text), so there is every reason to zero them.
  const wipe = (): void => {
    for (const s of shares.values()) zero(s.share);
    if (envelope) {
      zero(envelope.ciphertext);
      zero(envelope.iv);
    }
    shares.clear();
    envelope = null;
    invalidateResult(); // zeros + nulls recoveredBytes and fires onInvalidated
    // Re-grade the controls against the state that is now EMPTY. Without this, wipe() dropped every byte
    // but left Reconstruct as the last input left it: enabled, on a card holding nothing. Reset happened to
    // hide that because it refreshes straight afterwards, and teardown (the nav-away / panel path) did not,
    // so a torn-down card still presented an enabled Reconstruct. The button cannot rebuild anything in that
    // state, but a control that stays lit after the material behind it is gone is exactly the thing an
    // operator reads as "the key is still here", so it is graded rather than left to the caller.
    refreshSharesUI();
    refreshReconstructEnabled();
  };

  // ---- 5. Reset: an explicit, always-available way to drop every byte held here and start clean. ---------
  const resetBtn = h(
    "button",
    { "data-dp": "restore-flow.button.reset", class: "btn btn--ghost btn--sm", type: "button" },
    svgIcon(ICON_REFRESH, { size: 13 }),
    "Start over",
  ) as HTMLButtonElement;
  resetBtn.addEventListener("click", () => {
    wipe();
    pasteField.control.value = "";
    pasteField.clearError();
    sharesErr.hidden = true;
    ciphertextErr.hidden = true;
    ciphertextStatus.textContent = "No encrypted key file loaded yet.";
    refreshSharesUI();
    refreshReconstructEnabled();
    toast({ message: "Cleared. Nothing was retained." });
  });

  const actions = h("div", { style: "display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2)" }, reconstructBtn);
  if (opts.showDownload) actions.appendChild(downloadBtn);
  actions.appendChild(resetBtn);
  card.appendChild(actions);
  card.appendChild(resultHost);

  refreshSharesUI();
  refreshReconstructEnabled();
  return { el: card, teardown: wipe };
}
