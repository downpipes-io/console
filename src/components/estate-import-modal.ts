// The "recover an estate from a signed export" modal. A
// bootstrapped Owner on a FRESH engine pastes the signed control-plane export JSON they pulled from a
// surviving destination bucket, its detached signature, and their recovery-kit signer.pub; the engine
// verifies the export against that pub (tamper-evidence) and re-imports only the DEFINITION -- it grants no
// operator access, so roles and identity providers are re-established by hand afterwards, and a cross-account
// import lands its downpipes disabled for rebind. No secret is entered here: the export is no-custody and the
// signer.pub is a PUBLIC key. The validate->submit pipeline is the pure parseEstateImportInput/runEstateImport.
//
// The pasted artefact may be a SEALED export (the default: engine/src/cron/control-plane-pass.ts seals it
// whenever a break-glass recipient is configured, which is always true on a ready engine). This modal now
// detects that shape and, ENTIRELY IN THIS BROWSER, opens it: the operator supplies their break-glass
// identity.key (or reassembles an M-of-N Shamir quorum -- the same reviewed component the in-console
// break-glass restore panel uses), the console verifies the sealed wrapper's detached signature against the
// pasted signer.pub, decapsulates the capsule and decrypts the body (lib/sealed-export-unseal.ts, a byte-for-
// byte port of engine/src/admin/control-plane-seal.ts), and hands the recovered plaintext -- alongside the
// still-sealed original artefact and its signature, for the engine's OWN independent re-verify -- to
// POST /control-plane/import-sealed. The private identity is used ONLY for the local capsule decap: it is
// never a field on any request this modal or lib/sealed-export-unseal.ts builds, and it is best-effort zeroed
// the moment the modal closes, however it closes (Cancel, Esc, click-out, or a completed import).
//
// "Best-effort zeroed" above covers this modal's OWN privateKey closure only; the mounted M-of-N
// reassembly card (renderReassemblyCard, reassembly.ts) independently holds raw Shamir shares, the envelope
// ciphertext/iv and, once quorum is met, a full decrypted identity.key in its own closure, with its own
// documented teardown() contract. Every exit below calls wipeAllKeyMaterial(), which wipes BOTH holders, so a
// reconstructed break-glass private can no longer survive the modal on a shared incident-response machine.
//
// Before this, the console's estate-import form structurally rejected the sealed artefact (it required five
// plaintext-only fields), so recovering into a fresh account after total loss was reachable only from the
// offline `downpipe unseal-export` command -- a terminal, against the standing no-customer-CLI rule. The
// plaintext path below is UNCHANGED.

import { h } from "../lib/dom.ts";
import { field } from "./field.ts";
import { openModal } from "./modal.ts";
import { toast } from "./toast.ts";
import { parseEstateImportInput, runEstateImport } from "../lib/control-plane-import.ts";
import { looksLikeControlPlaneExport } from "../lib/control-plane-recovery.ts";
import { looksLikeSealedControlPlaneExport, unsealControlPlaneExport, type SealedControlPlaneExport } from "../lib/sealed-export-unseal.ts";
import { wipeOnDisconnect } from "../screens/restore-flow/reassembly.ts";
import { renderBreakGlassKeyPanel } from "./break-glass-key-panel.ts";
import type { EngineClient, EstateImportResult } from "../api.ts";


export function openEstateImportModal(engine: EngineClient, onImported?: (result: EstateImportResult) => void): void {
  const exportField = field({
    id: "cp-import-export",
    label: "Signed control-plane export (.json or .sealed.json)",
    kind: "textarea",
    required: true,
    hint: "Paste the …/_RECOVERY/CONTROL-PLANE/<version>-<time>.json (or .sealed.json) file from your destination bucket. Most estates find the SEALED file: paste it as-is and supply your break-glass key below.",
    doc: { href: "https://docs.downpipes.io/operations/recovering-downpipes-itself", anchor: "case-2-the-whole-cloudflare-account-is-gone" },
    onInput: () => refreshSealedPanel(),
  });
  const sigField = field({
    id: "cp-import-sig",
    label: "Detached signature (.json.sig or .sealed.json.sig)",
    kind: "textarea",
    required: true,
    hint: "Paste the matching …json.sig (or …sealed.json.sig) file from the same bucket.",
    doc: { href: "https://docs.downpipes.io/operations/recovering-downpipes-itself", anchor: "case-2-the-whole-cloudflare-account-is-gone" },
  });
  const pubField = field({
    id: "cp-import-pub",
    label: "Recovery-kit signer.pub",
    kind: "textarea",
    required: true,
    hint: "Paste your kit's downpipe-signer-public-v1 line. It verifies the export against your own key; it is a public key, not a secret. For a sealed export this browser verifies it directly, before decrypting anything.",
    doc: { href: "https://docs.downpipes.io/operations/recovering-downpipes-itself", anchor: "case-2-the-whole-cloudflare-account-is-gone" },
  });
  const formError = h("p", { class: "field__error", role: "alert", hidden: true });

  // ---- the sealed-only sub-panel: supply the break-glass identity, entirely in this browser. Hidden until
  // the pasted export looks sealed (calm-density: no irrelevant controls for the far more common plaintext
  // paste). The panel itself now lives in components/break-glass-key-panel.ts, whole and unchanged, because
  // sibling recovery flow needs the SAME collection and two hand-maintained copies of a surface holding
  // a reconstructed break-glass private key is the arrangement where one of them quietly stops wiping. Its
  // wipeAll() zeroes BOTH secret holders, which is a finding and the reason it exposes no narrower wipe.
  const keyPanel = renderBreakGlassKeyPanel({
    intro: "This is a SEALED export: opening it needs your break-glass key. It is read in this browser and never uploaded; only the definition it unseals is sent, on Import.",
  });
  const sealedPanel = keyPanel.el;

  // refreshSealedPanel toggles the sealed sub-panel from the CURRENT export text alone (a cheap, local,
  // pre-network read of the shape); it never runs the unseal itself (that only happens on Import, once the
  // signature can be checked against a signer.pub the operator has also supplied).
  function refreshSealedPanel(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(exportField.value());
    } catch {
      keyPanel.setVisible(false);
      return;
    }
    const isSealed = !looksLikeControlPlaneExport(parsed) && looksLikeSealedControlPlaneExport(parsed);
    // DELIBERATELY STRONGER THAN IT WAS. This branch used to call the modal's own wipePrivate(), which zeroed
    // the parsed identity and left the reassembly card's shares, envelope and reconstructed key untouched
    // behind a panel it had just hidden. That is the shape one level down: a partial wipe on a path that
    // looks like a wipe. A paste that is no longer sealed needs no key at all, so both holders go.
    if (!isSealed) keyPanel.wipeAll();
    keyPanel.setVisible(isSealed);
  }

  const body = h(
    "div",
    { class: "cp-recovery-form" },
    h(
      "p",
      { class: "cp-recovery-form__lead" },
      "Rebuild a lost estate's configuration on this fresh engine from a signed export you pulled out-of-band from your destination bucket. The engine verifies it against your recovery-kit signer.pub and imports only the definition (downpipes, destinations, discovery selection); it grants no operator access, so re-grant roles and reconnect identity providers by hand afterwards. Downpipes imported from a different Cloudflare account arrive disabled until you re-point each source.",
    ),
    exportField.el,
    sigField.el,
    pubField.el,
    sealedPanel,
    formError,
  );

  // every exit below wipes BOTH secret holders this modal mounts, not just its own privateKey
  // closure. The reassembly card independently holds raw Shamir shares, the envelope ciphertext/iv and (once
  // quorum is met) a full decrypted identity.key, none of which wipePrivate() above ever touched -- so a
  // Cancel/Esc/dismiss/success that stopped at wipePrivate() alone left a reconstructed break-glass private
  // key unzeroed in this tab's memory for the rest of the page's life. reassembly.teardown() is
  // best-effort-idempotent (reassembly.ts) and safe to call even when nothing was ever loaded into it.
  const wipeAllKeyMaterial = (): void => {
    keyPanel.wipeAll();
  };
  // NAVIGATING AWAY IS AN EXIT TOO, and it was the one exit that wiped nothing at all.
  //
  // Every wipe below hangs off a dialog callback: onDismiss, Cancel, or a successful import. app.ts's
  // afterEach calls closeAllOverlays() on every resolved navigation, and dialog.ts says in its own comment
  // that it tears every overlay down WITHOUT invoking their onClose callbacks, deliberately, so an onClose
  // that navigates cannot fight the navigation already under way. Both halves are right on their own. The
  // join between them meant that clicking any nav item with this modal open removed the modal and ran no
  // wipe: the reassembly card's shares, envelope and reconstructed key survived, AND so did this modal's own
  // decrypted privateKey, which even Cancel clears. It was the worst exit of the three, not a lesser one.
  //
  // A disconnect observer is the exit that closeAllOverlays cannot skip, and it is safe here for the reason
  // onClose is not: it only zeroes buffers, so there is no navigation for it to fight. wipeAllKeyMaterial is
  // idempotent, so the dismiss path firing it first and the observer firing it again costs nothing.
  wipeOnDisconnect(body, wipeAllKeyMaterial);
  openModal({
    title: "Recover an estate from a signed export",
    body,
    onDismiss: () => wipeAllKeyMaterial(),
    actions: [
      { label: "Cancel", variant: "secondary", onClick: () => wipeAllKeyMaterial() },
      {
        label: "Import",
        variant: "primary",
        busyLabel: "Importing",
        onClick: () => runImport(),
      },
    ],
  });

  // runImport validates, (for a sealed artefact) unseals entirely in this browser, relays, and reports.
  // Returns true to CLOSE the modal on success, false to KEEP it open on a validation error, an unseal
  // refusal, or an engine refusal so the operator can correct in place.
  async function runImport(): Promise<boolean> {
    showFormError("");
    const exportText = exportField.value().trim();
    if (exportText === "") {
      const parsed = parseEstateImportInput({ exportText: "", signatureText: sigField.value(), signerPublicText: pubField.value() });
      if (!parsed.ok) showFormError(parsed.error);
      return false;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(exportText);
    } catch {
      const parsed = parseEstateImportInput({ exportText, signatureText: sigField.value(), signerPublicText: pubField.value() });
      if (!parsed.ok) showFormError(parsed.error);
      return false;
    }

    if (looksLikeControlPlaneExport(parsedJson)) {
      // ---- the EXISTING, unchanged plaintext path. ----------------------------------------------------
      const parsed = parseEstateImportInput({ exportText, signatureText: sigField.value(), signerPublicText: pubField.value() });
      if (!parsed.ok) {
        showFormError(parsed.error);
        return false;
      }
      let done = false;
      await runEstateImport(engine, parsed.value, {
        onError: (msg) => showFormError(msg),
        onDone: (result) => {
          done = true;
          reportImported(result);
        },
      });
      return done;
    }

    if (looksLikeSealedControlPlaneExport(parsedJson)) {
      // ---- the sealed path. Everything through the unseal happens in this browser. ---------------
      const sigText = sigField.value().trim();
      const pubText = pubField.value().trim();
      if (sigText === "") {
        showFormError("Paste the detached signature (the matching …sealed.json.sig file from your destination bucket).");
        return false;
      }
      if (pubText === "") {
        showFormError("Paste your recovery kit's signer.pub (the downpipe-signer-public-v1 line) so this browser can verify the sealed artefact against your own key.");
        return false;
      }
      const identity = keyPanel.identity();
      if (!identity) {
        showFormError("Supply your break-glass identity.key (or reassemble a split key) above before importing a sealed export.");
        return false;
      }
      const unsealed = await unsealControlPlaneExport(parsedJson as SealedControlPlaneExport, sigText, pubText, identity);
      if (!unsealed.ok) {
        showFormError(unsealed.error);
        return false;
      }
      try {
        const result = await engine.controlPlaneImportSealed(unsealed.sealed, unsealed.sealedSignature, unsealed.signerPublic, unsealed.exportArtefact);
        wipeAllKeyMaterial();
        reportImported(result);
        return true;
      } catch (err) {
        showFormError(err instanceof Error ? err.message : String(err));
        return false;
      }
    }

    // Neither shape: reuse parseEstateImportInput's own DP-R03 message + ring recording.
    const parsed = parseEstateImportInput({ exportText, signatureText: sigField.value(), signerPublicText: pubField.value() });
    if (!parsed.ok) showFormError(parsed.error);
    return false;
  }

  function reportImported(result: EstateImportResult): void {
    const disabled = result.downpipesDisabled
      ? " They are disabled (imported from a different Cloudflare account): re-point each source, then enable them."
      : "";
    toast({
      message: `Estate imported: ${result.downpipes} downpipe(s), ${result.destinations} destination(s).${disabled} No operator access was imported; re-grant roles and reconnect identity providers by hand.`,
      durationMs: 0,
    });
    onImported?.(result);
  }

  function showFormError(message: string): void {
    if (message === "") {
      formError.hidden = true;
      formError.textContent = "";
      return;
    }
    formError.hidden = false;
    formError.textContent = message;
  }
}
