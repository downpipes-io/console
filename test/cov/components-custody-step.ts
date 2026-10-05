// Coverage for src/components/custody-step.ts: the optional "keep the break-glass key safe
// offline" ceremony step (ENTERPRISE-UX-BLUEPRINT section 7.3). It renders the tier menu,
// the per-tier panels (Tier 1 password manager, Tier 2 encrypted USB plus paper, and the
// M-of-N custodian split), performs the real in-browser envelope encryption and Shamir
// split, and hands back PUBLIC metadata plus local downloads. The crux it must honour is
// no-custody: nothing is transmitted; every key, share and ciphertext is offered only as a
// download. This validator renders the REAL component under the shared DOM shim (no jsdom,
// no network) and drives its behaviour, so each assertion exercises production code rather
// than re-implementing it.
//
// Run with: node test/cov/components-custody-step.ts
//
// Surfaces driven (and the contract each asserts):
//   renderCustodyStep / emitMeta   initial metadata is the undecided scheme; choosing each
//                                   tier re-emits the matching public metadata and swaps the
//                                   panel; the in-browser-only badge is present.
//   renderTier12 / doTier12Encrypt the encrypt button is enabled (the security-key layer is
//                                   off), encrypting downloads the ciphertext plus the random
//                                   wrapping key, and the decrypted ciphertext recovers the
//                                   identity bytes; Tier 2 also offers the paper companion; a
//                                   download helper that throws surfaces the in-browser error
//                                   line (nothing left the device).
//   renderSingleSignoff            an empty holder and date record NO sign-off; typing a
//                                   holder records one; clearing both clears it again.
//   renderSplit / refresh / doSplit valid N and threshold enable the split and size the
//                                   sign-off list; invalid params disable it with a reason;
//                                   splitting downloads the ciphertext, the readme and one file
//                                   per share, every share parses back and any threshold
//                                   combine to recover the identity; re-download re-emits a
//                                   file; a throwing download surfaces the in-browser error; a browser
//                                   that REFUSES the downloads (answers false rather than throwing) gets
//                                   a line naming the files that never reached disk, and that is not
//                                   reported as a failed split.
//   renderShareSignoffs / upsert   per-share holder inputs sync into the public sign-offs.
//   renderPaperCompanion           single-code and multi-code plans; chunk downloads; the printed
//                                   text is the whole identity.key.enc file and recovers the key with
//                                   the wrapping key; a text that does not read back warns.
//
// No-custody hygiene asserted: the onChange metadata for every tier carries only the scheme,
// the N/threshold and the custodian holders, never an identity byte, wrapping key, ciphertext
// or share body. The downloads are recorded locally by the test; nothing is logged.

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "../dom-shim.ts";

import { verdictReached } from "../lib/verdict-guard.ts"; // ARMS the completion guard
// Install the shim BEFORE importing the component (lib/dom.ts and several components create
// elements at load time).
installDomShim();

const custody = await import("../../src/components/custody-step.ts");
const { renderCustodyStep, renderPaperCompanion } = custody;
const keygen = await import("../../src/keygen.ts");
const envelope = await import("../../src/lib/envelope.ts");
const shamir = await import("../../src/lib/shamir.ts");
const custodyFiles = await import("../../src/lib/custody-files.ts");
const bytes = await import("../../src/bytes.ts");
const custodyLib = await import("../../src/lib/custody.ts");
const errorsLib = await import("../../src/lib/errors.ts");
const custodyPanels = await import("../../src/components/custody-step-panels.ts");
const ring = await import("../../src/lib/client-diag/ring.ts");

type CeremonyResult = import("../../src/keygen.ts").CeremonyResult;
type CustodyMetadata = import("../../src/lib/custody.ts").CustodyMetadata;
type CustodyPanelContext = import("../../src/components/custody-step-panels.ts").CustodyPanelContext;

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// A real ceremony result so identityPlaintext (which reads breakGlass.identityB64) produces
// genuine bytes the envelope round-trip can recover. runKeyCeremony generates real key
// material in-browser, exactly as the operator's local ceremony does.
const result: CeremonyResult = await keygen.runKeyCeremony({ operational: false });

// A local download recorder (the host's blob-download helper is passed in; here we capture
// name/content so a test can assert WHAT was offered, and prove the recovered bytes match).
interface Download {
  name: string;
  content: string;
}
// The recorder returns a boolean because the real downloadText does, and that boolean is load-bearing:
// it is whether the browser ACCEPTED the delivery. A browser that blocks the second and subsequent
// automatic downloads does not throw, so the component asks rather than assumes, and reports the files
// that never arrived.
//
// A stub that returned void would hand the component `undefined`, which reads as a refusal, so every
// case would render "Your browser did not deliver N of these files" while asserting nothing about
// delivery: the mismatch would be invisible from both sides.
//
// `accepted` makes the answer deliberate rather than accidental, and lets the refusal be tested rather
// than merely suffered.
function makeRecorder(accepted = true): { downloads: Download[]; downloadText: (name: string, content: string) => boolean } {
  const downloads: Download[] = [];
  return {
    downloads,
    downloadText: (name, content) => {
      downloads.push({ name, content });
      return accepted;
    },
  };
}

// metas records every onChange emission so a test can read the latest public metadata.
function makeMetas(): { metas: CustodyMetadata[]; onChange: (m: CustodyMetadata) => void } {
  const metas: CustodyMetadata[] = [];
  return { metas, onChange: (m) => void metas.push(m) };
}

// fireInput dispatches an input event so the field "input" listeners (the sign-off sync and
// the split refresh) run, mirroring a real keystroke.
function fireInput(control: ShimNode): void {
  control.dispatchEvent({
    type: "input",
    target: control,
    currentTarget: control,
    defaultPrevented: false,
    bubbles: true,
    preventDefault() {},
    stopPropagation() {},
  });
}

function setFieldValue(root: ShimNode, id: string, value: string): ShimNode {
  const el = qs(root, `#${id}`)!;
  el.value = value;
  fireInput(el);
  return el;
}

// ---- 1. Initial render: undecided metadata + the menu + the in-browser badge -----------------

{
  const { metas, onChange } = makeMetas();
  const { downloadText } = makeRecorder();
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  ok("initial onChange emits the undecided scheme", metas.length === 1 && metas[0]!.scheme === "undecided");
  ok("the in-browser-only guarantee is surfaced", textOf(root).includes("In-browser only"));
  ok("the radiogroup lists all three tiers", qsa(root, "input[type=\"radio\"]").length === 3);
  // The undecided panel renders a calm note rather than a tier body.
  ok("undecided panel shows the choose-a-scheme note", textOf(root).includes("Choose a scheme above"));
}

// ---- 2. Choosing Tier 1 (password manager): panel swap + emitMeta + real encryption ----------

{
  const { metas, onChange } = makeMetas();
  const { downloads, downloadText } = makeRecorder();
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  const pmRadio = qs(root, "#custody-scheme-password-manager")!;
  pmRadio.checked = true;
  pmRadio.dispatchEvent({
    type: "change",
    target: pmRadio,
    currentTarget: pmRadio,
    defaultPrevented: false,
    bubbles: false,
    preventDefault() {},
    stopPropagation() {},
  });

  const lastAfterSelect = metas[metas.length - 1]!;
  ok("selecting Tier 1 re-emits the password-manager scheme", lastAfterSelect.scheme === "password-manager");
  ok("Tier 1 panel shows the pre-encrypt affordance", textOf(root).includes("Optional: pre-encrypt the key file"));

  // The encrypt button is enabled because the security-key layer is off (updateEncryptGate
  // blocked=false). Find it and run the real in-browser encryption.
  const encryptBtn = qsa(root, "button").find((b) => textOf(b).includes("Encrypt the key file in this browser"))!;
  ok("the encrypt button is present and enabled", encryptBtn !== undefined && encryptBtn.disabled === false);

  encryptBtn.click();
  await flushAsync();

  ok("Tier 1 encrypt downloads the ciphertext", downloads.some((d) => d.name === custodyLib.CIPHERTEXT_FILENAME));
  ok("Tier 1 encrypt downloads the random wrapping key separately", downloads.some((d) => d.name === "identity.wrapping-key.txt"));

  // Round-trip proof: parse the downloaded ciphertext + wrapping key and recover the exact
  // identity.key bytes (the file the offline CLI reads). This proves the component wrapped the
  // real in-memory key, not a placeholder.
  const ctFile = downloads.find((d) => d.name === custodyLib.CIPHERTEXT_FILENAME)!.content;
  const wkFile = downloads.find((d) => d.name === "identity.wrapping-key.txt")!.content;
  const parsed = custodyFiles.parseEnvelopeFile(ctFile);
  const wrappingKey = custodyFiles.parseWrappingKeyFile(wkFile);
  const recovered = await envelope.decrypt(parsed.ciphertext, parsed.iv, wrappingKey);
  const expected = custodyFiles.identityPlaintext(result);
  ok("the ciphertext decrypts under the downloaded wrapping key to the identity bytes",
    recovered.length === expected.length && recovered.every((b, i) => b === expected[i]));

  // The success region states the in-browser outcome and the keep-apart warning.
  const out = qs(root, ".custody-out")!;
  ok("Tier 1 success states the ciphertext was downloaded", textOf(out).includes("Ciphertext downloaded"));
  ok("Tier 1 warns to keep the wrapping key apart", textOf(out).includes("Keep the wrapping key apart"));
  // Tier 1 does NOT offer the paper companion (that is Tier 2 only).
  ok("Tier 1 does not render the paper companion", qs(root, ".custody-paper") === null);

  // No-custody: the emitted metadata carries no secret material at all.
  const blob = JSON.stringify(metas);
  ok("Tier 1 metadata carries no identity/key/ciphertext bytes",
    !blob.includes(result.breakGlass.identityB64) && !blob.includes(wkFile.trim()) && !blob.includes(parsed.iv.join(",")));
}

// ---- 3. Choosing Tier 2 (encrypted USB + paper): the paper companion appears on encrypt -------

{
  const { onChange } = makeMetas();
  const { downloads, downloadText } = makeRecorder();
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  const usbRadio = qs(root, "#custody-scheme-encrypted-usb-paper")!;
  usbRadio.checked = true;
  usbRadio.dispatchEvent({
    type: "change", target: usbRadio, currentTarget: usbRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });

  const encryptBtn = qsa(root, "button").find((b) => textOf(b).includes("Encrypt the key file in this browser"))!;
  encryptBtn.click();
  await flushAsync();

  ok("Tier 2 encrypt downloads the ciphertext", downloads.some((d) => d.name === custodyLib.CIPHERTEXT_FILENAME));
  ok("Tier 2 renders the paper companion after encrypting", qs(root, ".custody-paper") !== null);
  ok("Tier 2 success copy points to the encrypted drive", textOf(qs(root, ".custody-out")!).includes("encrypted drive"));

  // The paper copy is the WHOLE identity.key.enc file, so it recovers the key alone. A copy of the bare
  // ciphertext with a hint to go and print the file's iv line as well would leave a paper-only recovery
  // with no IV. Read the printed text back with the parser the reader's format uses, and decrypt
  // what it yields under the downloaded wrapping key.
  const paper = qs(root, ".custody-paper")!;
  const printed = qs(paper, "pre")!;
  const ctFile = downloads.find((d) => d.name === custodyLib.CIPHERTEXT_FILENAME)!.content;
  const wkFile = downloads.find((d) => d.name === "identity.wrapping-key.txt")!.content;
  ok("the paper text is byte-identical to the downloaded identity.key.enc", textOf(printed) === ctFile);
  const fromPaper = custodyFiles.parseEnvelopeFile(textOf(printed));
  const recoveredFromPaper = await envelope.decrypt(fromPaper.ciphertext, fromPaper.iv, custodyFiles.parseWrappingKeyFile(wkFile));
  const expectedPlain = custodyFiles.identityPlaintext(result);
  ok("the paper text alone, with the wrapping key, recovers the identity bytes",
    recoveredFromPaper.length === expectedPlain.length && recoveredFromPaper.every((b, i) => b === expectedPlain[i]));
  ok("the paper companion confirms the text reads back as a complete file", textOf(paper).includes("reads back as a complete"));
  ok("the iv-line hint is gone, because the paper holds the iv line", !textOf(qs(root, ".custody-out")!).includes("Recovery also needs the iv line"));
}

// ---- 3b. Tier 1/2 with a browser that REFUSES a download: the panel says which file never arrived ----
//
// The Tier 1/2 twin of section 6c. The download helper answers false (a browser that blocks the second
// automatic download does not throw), so the panel must not say the file arrived. A doTier12Encrypt that
// ignored both answers would always print "Ciphertext downloaded" and "The wrapping key was downloaded",
// and this section fails on such code.

{
  const { onChange } = makeMetas();
  // Accept the ciphertext, refuse the wrapping key, then accept its re-download.
  const downloads: Download[] = [];
  let refuseWrappingKey = true;
  const downloadText = (name: string, content: string): boolean => {
    downloads.push({ name, content });
    return !(name === "identity.wrapping-key.txt" && refuseWrappingKey);
  };
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;
  const pmRadio = qs(root, "#custody-scheme-password-manager")!;
  pmRadio.checked = true;
  pmRadio.dispatchEvent({
    type: "change", target: pmRadio, currentTarget: pmRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });
  qsa(root, "button").find((b) => textOf(b).includes("Encrypt the key file in this browser"))!.click();
  await flushAsync();

  const out = qs(root, ".custody-out")!;
  ok("a refused wrapping key is reported, not claimed as downloaded", textOf(out).includes("did not deliver identity.wrapping-key.txt"));
  ok("the refused file is not described as downloaded", !textOf(out).includes("The wrapping key was downloaded"));
  ok("the delivered ciphertext is not named as missing", !textOf(out).includes(`did not deliver ${custodyLib.CIPHERTEXT_FILENAME}`));
  ok("the refusal warns that the wrapping key exists only on this page", textOf(out).includes("the wrapping key that opens identity.key.enc exists only on this page"));
  const reWk = qsa(root, "button").find((b) => b.getAttribute("aria-label") === "Re-download identity.wrapping-key.txt");
  const reCt = qsa(root, "button").find((b) => b.getAttribute("aria-label") === `Re-download ${custodyLib.CIPHERTEXT_FILENAME}`);
  ok("each Tier 1/2 file offers a Re-download control", reWk !== undefined && reCt !== undefined);

  // A re-download that the browser ALSO refuses keeps the warning.
  reWk!.click();
  ok("a refused re-download keeps the warning", textOf(out).includes("did not deliver identity.wrapping-key.txt"));
  // A re-download the browser accepts clears it, and offers the same wrapping key the first attempt did.
  refuseWrappingKey = false;
  reWk!.click();
  ok("an accepted re-download clears the warning", !textOf(out).includes("did not deliver"));
  ok("an accepted re-download states the delivery", textOf(out).includes("Ciphertext downloaded") && textOf(out).includes("The wrapping key was downloaded"));
  const wkOffers = downloads.filter((d) => d.name === "identity.wrapping-key.txt").map((d) => d.content);
  ok("every re-download offers the same wrapping key", wkOffers.length === 3 && wkOffers.every((c) => c === wkOffers[0]));
}

{
  // A browser that refuses both files: both are named, and nothing says either one arrived.
  const { onChange } = makeMetas();
  const { downloadText } = makeRecorder(false);
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;
  const usbRadio = qs(root, "#custody-scheme-encrypted-usb-paper")!;
  usbRadio.checked = true;
  usbRadio.dispatchEvent({
    type: "change", target: usbRadio, currentTarget: usbRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });
  qsa(root, "button").find((b) => textOf(b).includes("Encrypt the key file in this browser"))!.click();
  await flushAsync();
  const out = qs(root, ".custody-out")!;
  ok("both refused files are named", textOf(out).includes(`did not deliver ${custodyLib.CIPHERTEXT_FILENAME} or identity.wrapping-key.txt`));
  ok("a refused ciphertext is not claimed as downloaded", !textOf(out).includes("Ciphertext downloaded"));
  ok("with the wrapping key also refused, the warning names the wrapping key as the file only on this page", textOf(out).includes("the wrapping key that opens identity.key.enc exists only on this page"));
}

{
  // A browser that refuses ONLY the ciphertext. The wrapping key reached disk, so the warning must not
  // say it exists only on this page. The file only on this page is identity.key.enc, and the saved
  // wrapping key opens only that copy, because the next encrypt makes a new wrapping key.
  const { onChange } = makeMetas();
  const downloadText = (name: string, _content: string): boolean => name !== custodyLib.CIPHERTEXT_FILENAME;
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;
  const pmRadio = qs(root, "#custody-scheme-password-manager")!;
  pmRadio.checked = true;
  pmRadio.dispatchEvent({
    type: "change", target: pmRadio, currentTarget: pmRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });
  qsa(root, "button").find((b) => textOf(b).includes("Encrypt the key file in this browser"))!.click();
  await flushAsync();
  const out = qs(root, ".custody-out")!;
  ok("a refused ciphertext alone is named", textOf(out).includes(`did not deliver ${custodyLib.CIPHERTEXT_FILENAME}. `));
  ok("a refused ciphertext alone does not say the delivered wrapping key exists only on this page", !textOf(out).includes("the wrapping key that opens identity.key.enc exists only on this page"));
  ok(
    "a refused ciphertext alone says the ciphertext exists only on this page and the saved key opens only this copy",
    textOf(out).includes(`${custodyLib.CIPHERTEXT_FILENAME} exists only on this page, and the wrapping key you saved opens only this copy of it.`),
  );
  ok("the delivered wrapping key is stated as downloaded", textOf(out).includes("The wrapping key was downloaded"));
}

// ---- 4. Tier encrypt error path: a throwing download surfaces the in-browser error -----------

{
  const { onChange } = makeMetas();
  const downloads: Download[] = [];
  // First download call throws a non-Error so the catch path runs errMessage's String(err)
  // branch; nothing should claim to have left the device.
  let firstCall = true;
  // Returns true on the calls that do not throw: they recorded a download, so the delivery was
  // accepted. The subject here is the throw, not a refusal, and the two are different failures.
  const downloadText = (name: string, content: string): boolean => {
    if (firstCall) {
      firstCall = false;
      throw "disk full";
    }
    downloads.push({ name, content });
    return true;
  };
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  const pmRadio = qs(root, "#custody-scheme-password-manager")!;
  pmRadio.checked = true;
  pmRadio.dispatchEvent({
    type: "change", target: pmRadio, currentTarget: pmRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });

  const encryptBtn = qsa(root, "button").find((b) => textOf(b).includes("Encrypt the key file in this browser"))!;
  encryptBtn.click();
  await flushAsync();

  const out = qs(root, ".custody-out")!;
  ok("a throwing download surfaces the in-browser encryption error", textOf(out).includes("Encryption failed in the browser"));
  ok("the error reassures nothing left the device", textOf(out).includes("Nothing left this device"));
  // The button is re-enabled after the failure (setBtnBusy false), so the operator can retry.
  ok("the encrypt button is re-enabled after the error", encryptBtn.disabled === false);
}

// ---- 5. Single sign-off recorder: empty -> none, holder -> one, cleared -> none --------------

{
  const { metas, onChange } = makeMetas();
  const { downloadText } = makeRecorder();
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  const pmRadio = qs(root, "#custody-scheme-password-manager")!;
  pmRadio.checked = true;
  pmRadio.dispatchEvent({
    type: "change", target: pmRadio, currentTarget: pmRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });

  // The date is pre-filled with today; clear it AND the holder so sync records no row (a
  // prefilled date alone must not fabricate a sign-off).
  setFieldValue(root, "custody-dated-single", "");
  setFieldValue(root, "custody-holder-single", "");
  const afterEmpty = metas[metas.length - 1]!;
  ok("an empty holder and date record no custodian sign-off", (afterEmpty.signoffs ?? []).length === 0);

  // Typing a holder records one sign-off (shareIndex 1). The date is empty, so signedOn is omitted.
  setFieldValue(root, "custody-holder-single", "Alex Chen, Security");
  const afterHolder = metas[metas.length - 1]!;
  ok("typing a holder records one sign-off", (afterHolder.signoffs ?? []).length === 1 && afterHolder.signoffs![0]!.holder === "Alex Chen, Security");
  ok("the holder-only sign-off omits signedOn", afterHolder.signoffs![0]!.signedOn === undefined);

  // Add a date: the sign-off now carries signedOn.
  setFieldValue(root, "custody-dated-single", "2026-06-09");
  const afterDate = metas[metas.length - 1]!;
  ok("adding a date records signedOn on the sign-off", afterDate.signoffs![0]!.signedOn === "2026-06-09");

  // Clearing the holder AND the date clears the sign-off entirely.
  setFieldValue(root, "custody-holder-single", "");
  setFieldValue(root, "custody-dated-single", "");
  const afterClear = metas[metas.length - 1]!;
  ok("clearing both fields clears the sign-off", (afterClear.signoffs ?? []).length === 0);

  // A holder typed and then cleared, with the date still filled (the prefill is today), records NO row.
  // A sync that kept a row whenever either field was non-empty would leave a sign-off with a blank
  // holder and a date: the recovery sheet would then date a hand-over to nobody.
  setFieldValue(root, "custody-dated-single", "2026-09-24");
  setFieldValue(root, "custody-holder-single", "Alex Chen, Security");
  setFieldValue(root, "custody-holder-single", "");
  const afterHolderCleared = metas[metas.length - 1]!;
  ok("a holder cleared with the date still set records no sign-off", (afterHolderCleared.signoffs ?? []).length === 0);
  // A date edited on its own, with no holder, records nothing either.
  setFieldValue(root, "custody-dated-single", "2026-09-25");
  ok("a date edited with no holder records no sign-off", (metas[metas.length - 1]!.signoffs ?? []).length === 0);
  // A whitespace-only holder is blank: it records nothing.
  setFieldValue(root, "custody-holder-single", "   ");
  ok("a whitespace-only holder records no sign-off", (metas[metas.length - 1]!.signoffs ?? []).length === 0);

  // No-custody: the recorded holder text is the only operator string; no key bytes appear.
  ok("sign-off metadata never carries the identity bytes", !JSON.stringify(metas).includes(result.breakGlass.identityB64));
}

// ---- 6. M-of-N split: valid/invalid params, the real split + recovery, re-download ------------

{
  const { metas, onChange } = makeMetas();
  const { downloads, downloadText } = makeRecorder();
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  const splitRadio = qs(root, "#custody-scheme-mofn-split")!;
  splitRadio.checked = true;
  splitRadio.dispatchEvent({
    type: "change", target: splitRadio, currentTarget: splitRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });

  const lastAfterSelect = metas[metas.length - 1]!;
  ok("selecting the split emits the mofn-split scheme with N and threshold",
    lastAfterSelect.scheme === "mofn-split" && lastAfterSelect.n === 5 && lastAfterSelect.threshold === 3);

  const splitBtn = qsa(root, "button").find((b) => textOf(b).includes("Encrypt and split in this browser"))!;
  ok("default 5-of-3 parameters enable the split button", splitBtn.disabled === false);

  // Invalid: threshold greater than N must disable the button with a precise reason.
  setFieldValue(root, "custody-split-threshold", "9");
  ok("threshold above N disables the split button", splitBtn.disabled === true);
  ok("an invalid threshold shows a validity reason", textOf(qs(root, ".custody-tier")!).includes("threshold cannot exceed"));

  // Below-minimum N is also rejected.
  setFieldValue(root, "custody-split-threshold", "3");
  setFieldValue(root, "custody-split-n", "1");
  ok("N below the minimum disables the split button", splitBtn.disabled === true);

  // Restore a valid 4-of-2 and confirm the validity line + that the sign-off list resized to N.
  setFieldValue(root, "custody-split-n", "4");
  setFieldValue(root, "custody-split-threshold", "2");
  ok("a valid 4-of-2 re-enables the split button", splitBtn.disabled === false);
  ok("the validity line confirms the parameters", textOf(qs(root, ".custody-tier")!).includes("any 2 of 4 shares"));
  ok("the sign-off list resized to N share rows", qsa(root, ".custody-share-row").length === 4);

  // Record a share-1 holder so renderShareSignoffs / upsertSignoff sync into the public meta.
  setFieldValue(root, "custody-share-holder-1", "Jordan, Finance");
  const afterShareHolder = metas[metas.length - 1]!;
  const share1 = (afterShareHolder.signoffs ?? []).find((s) => s.shareIndex === 1);
  ok("a per-share holder syncs into the public sign-offs", share1?.holder === "Jordan, Finance");

  // Run the real in-browser envelope + Shamir split.
  splitBtn.click();
  await flushAsync();

  ok("the split downloads the ciphertext", downloads.some((d) => d.name === custodyLib.CIPHERTEXT_FILENAME));
  ok("the split downloads the recovery readme", downloads.some((d) => d.name === custodyLib.SPLIT_README_FILENAME));
  const shareDownloads = downloads.filter((d) => /^downpipe-share-\d+-of-4\.txt$/.test(d.name));
  ok("the split downloads one file per share", shareDownloads.length === 4);

  // Round-trip proof: any threshold (2) of the parsed shares combine to the wrapping key, and
  // the ciphertext decrypts under it to the identity bytes. The checksum stored in each share
  // verifies the recombined key.
  const ctFile = downloads.find((d) => d.name === custodyLib.CIPHERTEXT_FILENAME)!.content;
  const parsed = custodyFiles.parseEnvelopeFile(ctFile);
  const s0 = custodyFiles.parseShareFile(shareDownloads[0]!.content);
  const s1 = custodyFiles.parseShareFile(shareDownloads[1]!.content);
  const wrappingKey = shamir.combine([s0.share, s1.share]);
  ok("the recombined key matches the per-share PUBLIC checksum", shamir.verifyWrappingKey(wrappingKey, s0.checksum));
  const recovered = await envelope.decrypt(parsed.ciphertext, parsed.iv, wrappingKey);
  const expected = custodyFiles.identityPlaintext(result);
  ok("any threshold of shares recover the identity bytes",
    recovered.length === expected.length && recovered.every((b, i) => b === expected[i]));

  // The success region states the honest outcome: everything generated in this browser, downloads
  // stay local, and (should a share be emailed) Maelstrom still receives nothing.
  const out = qs(root, ".custody-out")!;
  ok("the split success states everything was generated in this browser", textOf(out).includes("Everything here was generated in this browser"));
  ok("the split success preserves the no-custody claim", textOf(out).includes("Maelstrom receives nothing"));

  // Re-download a share: it re-emits the SAME share file content (the bytes are regenerated
  // from the held share, deterministically).
  const before = downloads.length;
  const reDl = qsa(root, "button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Re-download downpipe-share-1-of-4"))!;
  reDl.click();
  ok("re-download offers the share file again", downloads.length === before + 1);
  ok("the re-downloaded share parses to the same share bytes",
    (() => {
      const again = custodyFiles.parseShareFile(downloads[downloads.length - 1]!.content);
      return again.index === s0.index && again.share.length === s0.share.length && again.share.every((b, i) => b === s0.share[i]);
    })());

  // No-custody: the metadata never carries a share body, the wrapping key or the ciphertext.
  const blob = JSON.stringify(metas);
  ok("split metadata carries no share/key/ciphertext bytes",
    !blob.includes(bytes.b64urlEncode(s0.share)) && !blob.includes(bytes.b64urlEncode(wrappingKey)) && !blob.includes(result.breakGlass.identityB64));
}

// ---- 6b. Emailing a share to a custodian (the one sanctioned network exception) ---------------

{
  const { onChange } = makeMetas();
  const { downloadText } = makeRecorder();
  // A stub sender standing in for EngineClient.sendCustodyShare: it records the posted body and
  // returns a configurable result, so the test can drive the success path and the refusal path
  // without a real engine, and prove that the SHARE (never the ciphertext) is what gets posted.
  // A recorder written only from inside a callback: on a local `let` the compiler keeps the
  // narrowing from its initialiser, because it cannot see the callback run, so the assertion below
  // reads as always-false and proves nothing. Narrowing on an object's properties is discarded at
  // each call, which is the assumption that holds here.
  const rec: { posted: { toEmail: string; shareB64: string; n: number; m: number; custodianLabel?: string } | null } = { posted: null };
  let sendResult: { sent: boolean; reason?: string } = { sent: true };
  const root = renderCustodyStep({
    result,
    onChange,
    downloadText,
    sendShare: async (input) => { rec.posted = input; return sendResult; },
  }) as unknown as ShimNode;

  // Get to a split success (3-of-2), then the per-share rows carry an Email action.
  const splitRadio = qs(root, "#custody-scheme-mofn-split")!;
  splitRadio.checked = true;
  splitRadio.dispatchEvent({ type: "change", target: splitRadio, currentTarget: splitRadio, defaultPrevented: false, bubbles: false, preventDefault() {}, stopPropagation() {} });
  setFieldValue(root, "custody-split-n", "3");
  setFieldValue(root, "custody-split-threshold", "2");
  qsa(root, "button").find((b) => textOf(b).includes("Encrypt and split in this browser"))!.click();
  await flushAsync();

  const emailButtons = qsa(root, "button").filter((b) => textOf(b).trim() === "Email");
  ok("each share offers an Email action when the host wired a sender", emailButtons.length === 3);

  // Open share 1's email form and send it to a custodian.
  emailButtons[0]!.click();
  ok("clicking Email reveals the address form for that share", qs(root, "#custody-share-email-1") !== null);
  setFieldValue(root, "custody-share-email-1", "alex@corp.example");
  setFieldValue(root, "custody-share-emaillabel-1", "Alex, Security");
  const sendBtn = qsa(root, "button").find((b) => textOf(b).trim() === "Send this share")!;
  sendBtn.click();
  await flushAsync();

  ok("Send posts the share to the injected sender", rec.posted !== null && rec.posted.toEmail === "alex@corp.example");
  // Bound to a const so the four assertions below read a value that is known to be there: a stub that
  // was never called would otherwise fail one assertion via a non-null assertion and throw a TypeError
  // on the next, so the throw here says WHICH thing did not happen instead.
  const sent = rec.posted;
  if (sent === null) throw new Error("the stub sender was never called, so the assertions below would prove nothing");
  ok("Send posts a non-empty base64url share (never the ciphertext)", typeof sent.shareB64 === "string" && sent.shareB64.length > 0);
  ok("Send posts the scheme counts and the optional label", sent.n === 3 && sent.m === 2 && sent.custodianLabel === "Alex, Security");
  ok("the posted body carries no identity or ciphertext bytes", !JSON.stringify(sent).includes(result.breakGlass.identityB64));
  ok("a successful send confirms to the operator", textOf(qs(root, ".custody-share-email")!).includes("Emailed to alex@corp.example"));

  // The refusal path: an unconfigured engine returns a coarse reason, surfaced as specific guidance.
  sendResult = { sent: false, reason: "email-not-configured" };
  sendBtn.click();
  await flushAsync();
  ok("an email-not-configured refusal surfaces set-up guidance", textOf(qs(root, ".custody-share-email")!).includes("Outbound email is not set up"));

  // Each refusal reason the send can return reaches its own line, never the generic "was not sent
  // (reason)" fallback. The engine's real 429 reason is "rate limited" with a space, which a hyphenated
  // match alone misses, and a 401 must not read as the generic line with no remedy.
  const refusalLine = async (reason: string): Promise<string> => {
    sendResult = { sent: false, reason };
    sendBtn.click();
    await flushAsync();
    return textOf(qs(root, ".custody-share-email")!);
  };
  const rateLimited = await refusalLine("rate limited");
  ok("the engine's 429 reason 'rate limited' reaches the rate-limit line", rateLimited.includes("Too many sends just now") && !rateLimited.includes("was not sent ("));
  ok("a 429 with no engine body reaches the rate-limit line", (await refusalLine("send-failed-429")).includes("Too many sends just now"));
  const accessLine = await refusalLine("access-reauth-required");
  ok("an Access step-up refusal names the Access sign-in and says nothing was sent", accessLine.includes("Cloudflare Access sign-in from the last five minutes") && accessLine.includes("Nothing was sent"));
  ok("the Access line keeps the operator on this page", accessLine.includes("If you reload this page, you must split the key again"));
  // With no ceremony record (a token or Access session runs no passkey ceremony), the retry line is the answer.
  errorsLib.noteStepUpFailure(null);
  const stepUpLine = await refusalLine("stepup-required");
  ok("a passkey step-up refusal asks for the passkey on the next send", stepUpLine.includes("confirm with your passkey when asked") && !stepUpLine.includes("was not sent ("));
  // With a ceremony record, the line is the one for that reason. An account with no passkey enrolled
  // cannot pass by a retry, so the retry advice must not appear, and the record is consumed.
  errorsLib.noteStepUpFailure("no-passkey");
  const noPasskeyLine = await refusalLine("stepup-required");
  ok("a no-passkey step-up refusal says nothing was sent", noPasskeyLine.includes("Nothing was sent. "));
  ok("a no-passkey step-up refusal gets the no-passkey line", noPasskeyLine.includes(errorsLib.stepUpFailureMessage("no-passkey")));
  ok("a no-passkey step-up refusal does not tell the operator to retry with a passkey", !noPasskeyLine.includes("confirm with your passkey when asked"));
  ok("the panel consumes the ceremony record", errorsLib.takeStepUpFailure() === null);
  errorsLib.noteStepUpFailure("browser-refused");
  const browserRefusedLine = await refusalLine("stepup-required");
  ok("a browser-refused step-up refusal gets the browser-refused line, not retry advice", browserRefusedLine.includes(errorsLib.stepUpFailureMessage("browser-refused")) && !browserRefusedLine.includes("confirm with your passkey when asked"));
  const lapsedLine = await refusalLine("send-failed-401");
  ok("a session the engine did not accept gets its own line, not the generic one", lapsedLine.includes("did not accept your session") && !lapsedLine.includes("was not sent ("));
  ok("the unknown-reason fallback still names the reason", (await refusalLine("mystery")).includes("The share was not sent (mystery)"));

  // The empty-address guard: clearing the field and sending asks for an address without posting.
  rec.posted = null;
  setFieldValue(root, "custody-share-email-1", "");
  sendBtn.click();
  await flushAsync();
  ok("an empty address is caught before any send", rec.posted === null && textOf(qs(root, ".custody-share-email")!).includes("Enter the custodian's email address"));

  // A host that does NOT wire a sender gets a download-only split (no Email action at all).
  const { onChange: onChange2 } = makeMetas();
  const { downloadText: downloadText2 } = makeRecorder();
  const rootNoEmail = renderCustodyStep({ result, onChange: onChange2, downloadText: downloadText2 }) as unknown as ShimNode;
  const splitRadio2 = qs(rootNoEmail, "#custody-scheme-mofn-split")!;
  splitRadio2.checked = true;
  splitRadio2.dispatchEvent({ type: "change", target: splitRadio2, currentTarget: splitRadio2, defaultPrevented: false, bubbles: false, preventDefault() {}, stopPropagation() {} });
  qsa(rootNoEmail, "button").find((b) => textOf(b).includes("Encrypt and split in this browser"))!.click();
  await flushAsync();
  ok("without a wired sender the split is download-only (no Email action)", qsa(rootNoEmail, "button").filter((b) => textOf(b).trim() === "Email").length === 0);
}

// ---- 6c. A browser that REFUSES the downloads: the split says which files never arrived --------
//
// Distinct from section 7, and the distinction is the whole point. There, the download helper THROWS and
// the split reports that it failed. Here every call returns cleanly and simply answers false, which is
// what a browser does when it blocks the second and subsequent automatic downloads: no exception, no
// signal, nothing for the component to catch. The split genuinely succeeded, so the panel renders as
// normal, and the only evidence the operator gets that the files are not on their disk is this line.
//
// It is worth being blunt about why that matters here. The wrapping key exists only in the closure that
// made it, so a share that never reached disk cannot be recovered by re-running anything: navigate away
// and the ciphertext is permanently unopenable. That is the failure this warning exists to prevent.

{
  const { metas, onChange } = makeMetas();
  const { downloads, downloadText } = makeRecorder(false);
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  const splitRadio = qs(root, "#custody-scheme-mofn-split")!;
  splitRadio.checked = true;
  splitRadio.dispatchEvent({
    type: "change", target: splitRadio, currentTarget: splitRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });

  const splitBtn = qsa(root, "button").find((b) => textOf(b).includes("Encrypt and split in this browser"))!;
  splitBtn.click();
  await flushAsync();

  const shown = textOf(root);
  ok("a refused delivery is reported rather than swallowed", shown.includes("did not deliver"));
  // 5-of-3 by default: the ciphertext, the readme and five share files were all offered and all refused.
  ok("the warning counts every refused file", shown.includes("did not deliver 7 of these files"));
  // Read the warning ELEMENT, not the panel. Asserting the filename appears somewhere in the rendered
  // text passes whether or not the warning names it, because the split panel lists that filename anyway.
  // Checked by flipping the stub to accept: this assertion has to fail there, and against the panel it
  // did not.
  const warning = qsa(root, ".field__error").map((e) => textOf(e)).join(" ");
  ok("the warning names them, so the operator knows what to re-download", warning.includes(custodyLib.CIPHERTEXT_FILENAME));
  ok("the component still attempted every delivery", downloads.length === 7);
  // The split itself worked, so the failure must not be reported as a split failure: the operator's
  // remedy is the Re-download buttons, not running the ceremony again.
  ok("a refused delivery is not reported as a failed split", !shown.includes("Split failed in the browser"));
  ok("the split still emitted its public metadata", metas[metas.length - 1]!.scheme === "mofn-split");
}

// ---- 6c. The shamir-split step is recorded against the reconstruction self-test's own outcome,
// not against whether the split call itself threw. Drives renderSplitOutput directly (a real
// envelope and real shares from a real split, so combine/verifyWrappingKey run for real) with a
// deliberately wrong checksum, and separately with too few shares for its own combine, so the
// self-test genuinely fails and genuinely throws rather than being stubbed. ------------------

if (typeof custodyPanels.renderSplitOutput !== "function") {
  ok("renderSplitOutput can be driven directly to exercise the self-test outcome", false);
} else {
  const renderSplitOutput6c = custodyPanels.renderSplitOutput;
  const ctx6c: CustodyPanelContext = {
    state: { scheme: "mofn-split", splitN: 4, splitThreshold: 2, signoffs: [] },
    result,
    downloadText: () => true,
    emitMeta: () => {},
  };
  const plaintext6c = custodyFiles.identityPlaintext(result);
  const env6c = await envelope.encrypt(plaintext6c);
  const shares6c = shamir.split(env6c.wrappingKey, 4, 2);
  const goodChecksum6c = shamir.wrappingKeyChecksum(env6c.wrappingKey);
  const wrongChecksum6c = goodChecksum6c.slice();
  wrongChecksum6c[0] = (wrongChecksum6c[0]! ^ 0xff) & 0xff;

  const stepRows6c = (): { ceremonyOutcome?: string; ceremonyFault?: string }[] =>
    ring.snapshot().records.filter((r) => r.kind === "ceremony-step" && r.ceremonyStep === "shamir-split");

  // A checksum that does not match: verifyWrappingKey genuinely returns false.
  ring.reset();
  const failOut6c = document.createElement("div") as unknown as HTMLElement;
  renderSplitOutput6c(ctx6c, failOut6c, env6c, shares6c, wrongChecksum6c, 4, 2);
  const failRows6c = stepRows6c();
  ok("a self-test that does not verify records a FAILED shamir-split step",
    failRows6c.some((r) => r.ceremonyOutcome === "failed" && r.ceremonyFault !== undefined));
  ok("a self-test that does not verify records no PASSED shamir-split step",
    !failRows6c.some((r) => r.ceremonyOutcome === "ok"));
  ok("the screen still shows its do-not-distribute state on a failed self-test",
    textOf(failOut6c).includes("Do not distribute these shares"));

  // Too few shares for the self-test's own combine: it throws.
  ring.reset();
  const throwOut6c = document.createElement("div") as unknown as HTMLElement;
  renderSplitOutput6c(ctx6c, throwOut6c, env6c, shares6c, goodChecksum6c, 4, 1);
  const throwRows6c = stepRows6c();
  ok("a self-test whose combine throws records a FAILED shamir-split step", throwRows6c.some((r) => r.ceremonyOutcome === "failed"));
  ok("a self-test whose combine throws records no PASSED shamir-split step", !throwRows6c.some((r) => r.ceremonyOutcome === "ok"));
  ok("the screen still shows its do-not-distribute state when the self-test throws",
    textOf(throwOut6c).includes("Do not distribute these shares"));

  // The correct checksum: a genuinely passing self-test still records a passed step.
  ring.reset();
  const okOut6c = document.createElement("div") as unknown as HTMLElement;
  renderSplitOutput6c(ctx6c, okOut6c, env6c, shares6c, goodChecksum6c, 4, 2);
  const okRows6c = stepRows6c();
  ok("a passing self-test records a PASSED shamir-split step", okRows6c.some((r) => r.ceremonyOutcome === "ok"));
  ok("a passing self-test records no FAILED shamir-split step", !okRows6c.some((r) => r.ceremonyOutcome === "failed"));
  ring.reset();
}

// ---- 6d. A passed step already on the ring does not stand in for a LATER, separate self-test that
// genuinely fails: reproduces the original shape (a passed row already recorded, then a distinct
// self-test that fails) through two real, exported entry points: the split button's own doSplit,
// and renderSplitOutput driven directly, with nothing stubbed. ------------------------------------

if (typeof custodyPanels.renderSplitOutput !== "function") {
  ok("renderSplitOutput can be driven directly to exercise a later failing self-test", false);
} else {
  const renderSplitOutput6d = custodyPanels.renderSplitOutput;
  ring.reset();

  // A real split, driven through the real button with valid default parameters: Shamir reconstruction
  // cannot be made to fail through valid UI inputs alone, so this genuinely passes and records a passed
  // shamir-split step, by whichever code path the running source uses to record it.
  const { onChange: onChange6d } = makeMetas();
  const { downloadText: downloadText6d } = makeRecorder();
  const root6d = renderCustodyStep({ result, onChange: onChange6d, downloadText: downloadText6d }) as unknown as ShimNode;
  const splitRadio6d = qs(root6d, "#custody-scheme-mofn-split")!;
  splitRadio6d.checked = true;
  splitRadio6d.dispatchEvent({
    type: "change", target: splitRadio6d, currentTarget: splitRadio6d, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });
  const splitBtn6d = qsa(root6d, "button").find((b) => textOf(b).includes("Encrypt and split in this browser"))!;
  splitBtn6d.click();
  await flushAsync();

  const stepRows6d = (): { ceremonyOutcome?: string }[] =>
    ring.snapshot().records.filter((r) => r.kind === "ceremony-step" && r.ceremonyStep === "shamir-split");
  ok("the real split records a passed step", stepRows6d().some((r) => r.ceremonyOutcome === "ok"));

  // A SEPARATE self-test on independently generated real material, deliberately wrong-checksummed so
  // verifyWrappingKey genuinely fails, driven straight through the same exported renderSplitOutput.
  const ctx6d: CustodyPanelContext = {
    state: { scheme: "mofn-split", splitN: 4, splitThreshold: 2, signoffs: [] },
    result,
    downloadText: () => true,
    emitMeta: () => {},
  };
  const plaintext6d = custodyFiles.identityPlaintext(result);
  const env6d = await envelope.encrypt(plaintext6d);
  const shares6d = shamir.split(env6d.wrappingKey, 4, 2);
  const goodChecksum6d = shamir.wrappingKeyChecksum(env6d.wrappingKey);
  const wrongChecksum6d = goodChecksum6d.slice();
  wrongChecksum6d[0] = (wrongChecksum6d[0]! ^ 0xff) & 0xff;
  const failOut6d = document.createElement("div") as unknown as HTMLElement;
  renderSplitOutput6d(ctx6d, failOut6d, env6d, shares6d, wrongChecksum6d, 4, 2);

  ok("the earlier passed step is still on record", stepRows6d().some((r) => r.ceremonyOutcome === "ok"));
  ok("the later failing self-test also records its own FAILED step, not swallowed by the earlier pass",
    stepRows6d().some((r) => r.ceremonyOutcome === "failed"));
  ok("the failing self-test's screen shows its do-not-distribute state",
    textOf(failOut6d).includes("Do not distribute these shares"));
  ring.reset();
}

// ---- 7. Split error path: a throwing download surfaces the in-browser split error ------------

{
  const { onChange } = makeMetas();
  let firstCall = true;
  const downloadText = (_name: string, _content: string): boolean => {
    if (firstCall) {
      firstCall = false;
      throw new Error("quota exceeded");
    }
    return true;
  };
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  const splitRadio = qs(root, "#custody-scheme-mofn-split")!;
  splitRadio.checked = true;
  splitRadio.dispatchEvent({
    type: "change", target: splitRadio, currentTarget: splitRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });

  const splitBtn = qsa(root, "button").find((b) => textOf(b).includes("Encrypt and split in this browser"))!;
  splitBtn.click();
  await flushAsync();

  const out = qs(root, ".custody-out")!;
  ok("a throwing download surfaces the in-browser split error", textOf(out).includes("Split failed in the browser"));
  ok("the split error names the thrown reason", textOf(out).includes("quota exceeded"));
  ok("the split error reassures no share or key left the device", textOf(out).includes("No share or key left this device"));
}

// ---- 8. renderPaperCompanion: single-code, multi-code, and the read-back-fail branch ---------

// envelopeTextOf serialises an identity.key.enc file around a ciphertext of the given length, the only
// shape the companion is handed (custody-step-panels.ts doTier12Encrypt passes the downloaded file).
function envelopeTextOf(ciphertextLen: number): string {
  return custodyFiles.serialiseEnvelopeFile({ iv: new Uint8Array(12).fill(1), ciphertext: new Uint8Array(ciphertextLen).fill(9) });
}

{
  // A small file needs a single QR code; no chunk list is rendered, only the printable text.
  const { downloadText } = makeRecorder();
  const small = envelopeTextOf(48);
  const paper = renderPaperCompanion({ envelopeText: small, downloadText }) as unknown as ShimNode;
  ok("a small file needs a single QR code", textOf(paper).includes("it needs 1 code"));
  ok("a single-code file renders no chunk list", qs(paper, ".custody-qr-chunks") === null);
  ok("the printable text reads back as a complete file", textOf(paper).includes("reads back as a complete"));
  ok("the printed text is the whole file, magic and iv lines included", textOf(qs(paper, "pre")!) === small && small.startsWith(`${custodyFiles.ENVELOPE_FILE_MAGIC}\n`) && small.includes("\niv "));
}

{
  // THE PRODUCTION PAYLOAD, derived from real code rather than a chosen constant. The paper companion
  // has exactly one caller (custody-step-panels.ts doTier12Encrypt) and it is always handed the
  // serialiseEnvelopeFile text of the AES-256-GCM ciphertext of identityPlaintext. Every valid
  // identity.key is exactly 96 bytes (lib/keydecap.ts parseIdentityFile refuses any other length, and
  // screens/keys/custody.ts applies that same parser to the file picker), so the ciphertext line is a fixed
  // 222 base64url characters and the whole file a fixed 283 bytes (29 + 20 + 234 across its three lines),
  // against a QR_MAX_BYTES of 2,953: the chunk branch below is unreachable in production.
  //
  // This block pins that arithmetic directly: the single-code case above uses an arbitrary 48-byte
  // ciphertext, so a longer key format or a smaller per-code budget would make the no-chunk-button claim
  // silently false without this check.
  const { downloadText } = makeRecorder();
  const prodPlaintext = custodyFiles.identityPlaintext(result);
  const prodEnvelope = await envelope.encrypt(prodPlaintext);
  const prodText = custodyFiles.serialiseEnvelopeFile({ iv: prodEnvelope.iv, ciphertext: prodEnvelope.ciphertext });
  ok("the ceremony identity is the 96 bytes the restore path insists on", bytes.b64urlDecode(result.breakGlass.identityB64).length === 96);
  ok("the identity.key plaintext is 150 bytes", prodPlaintext.length === 150);
  ok("the production ciphertext line is 222 base64url characters", bytes.b64urlEncode(prodEnvelope.ciphertext).length === 222);
  ok("the production paper text is the 283-byte file", prodText.length === 283);
  ok("the production paper text plans exactly one QR code", custodyLib.planQrChunks(prodText.length, custodyLib.QR_MAX_BYTES).total === 1);
  const prodPaper = renderPaperCompanion({ envelopeText: prodText, downloadText }) as unknown as ShimNode;
  ok(
    "no chunk download button renders for the production payload",
    qsa(prodPaper, '[data-dp="components-custody-paper.button.download-text"]').length === 0,
  );
}

{
  // A file larger than one QR code's capacity needs several codes, each offered as a chunk download. Use a
  // ciphertext well over QR_MAX_BYTES so plan.total > 1.
  const { downloads, downloadText } = makeRecorder();
  const big = envelopeTextOf(custodyLib.QR_MAX_BYTES * 2 + 10);
  const plan = custodyLib.planQrChunks(big.length, custodyLib.QR_MAX_BYTES);
  ok("the large file plans more than one code", plan.total > 1);

  const paper = renderPaperCompanion({ envelopeText: big, downloadText }) as unknown as ShimNode;
  ok("a multi-code file renders the chunk list", qs(paper, ".custody-qr-chunks") !== null);
  const chunkButtons = qsa(paper, ".custody-qr-chunk button");
  ok("there is one download button per chunk", chunkButtons.length === plan.total);

  // Downloading every chunk and concatenating recovers the whole file (each chunk is a slice; the operator
  // feeds each to an offline QR tool). Order them by their index, and strip the one newline each download adds.
  for (const b of chunkButtons) b.click();
  const reassembled = downloads
    .filter((d) => /^qr-chunk-\d+-of-\d+\.txt$/.test(d.name))
    .sort((a, b) => Number(a.name.match(/^qr-chunk-(\d+)/)![1]) - Number(b.name.match(/^qr-chunk-(\d+)/)![1]))
    .map((d) => d.content.replace(/\n$/, ""))
    .join("");
  ok("the downloaded chunks reassemble to the full file", reassembled === big);
}

{
  // The read-back-fail branch: text that is not an identity.key.enc file warns rather than claiming the
  // printed copy is good. A bare ciphertext line is one such text: it has no magic line and no iv
  // line.
  const { downloadText } = makeRecorder();
  for (const bad of ["!!! not base64url @@@", bytes.b64urlEncode(new Uint8Array(48).fill(9))]) {
    const paper = renderPaperCompanion({ envelopeText: bad, downloadText }) as unknown as ShimNode;
    ok("a text that is not a whole file warns instead of claiming a clean copy", textOf(paper).includes("does not read back as a complete"));
    ok("and does not claim a clean read-back", !textOf(paper).includes("reads back as a complete identity"));
  }
  // A file cut short after the iv line (a truncated print) also warns.
  const cut = envelopeTextOf(48).split("\n").slice(0, 2).join("\n");
  ok("a file with no ciphertext line warns", textOf(renderPaperCompanion({ envelopeText: cut, downloadText }) as unknown as ShimNode).includes("does not read back as a complete"));
}

// ---- 9. Guard and growth branches: unchecked radio, grown sign-off list, dateless share ------

{
  const { metas, onChange } = makeMetas();
  const { downloadText } = makeRecorder();
  const root = renderCustodyStep({ result, onChange, downloadText }) as unknown as ShimNode;

  // A change event on a radio that is NOT checked is ignored (the early-return guard): the
  // browser fires change only on the newly-checked radio, but a stray event must not switch
  // the scheme. Dispatch change on the split radio while it is unchecked and confirm nothing
  // emits and the panel stays undecided.
  const before = metas.length;
  const splitRadio = qs(root, "#custody-scheme-mofn-split")!;
  splitRadio.checked = false;
  splitRadio.dispatchEvent({
    type: "change", target: splitRadio, currentTarget: splitRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });
  ok("a change on an unchecked radio is ignored", metas.length === before && textOf(root).includes("Choose a scheme above"));

  // Now select the split (5 shares) and GROW N to 10: resizeSignoffs must add fresh empty
  // entries for the new indices (the grow branch), so the sign-off list shows 10 rows.
  splitRadio.checked = true;
  splitRadio.dispatchEvent({
    type: "change", target: splitRadio, currentTarget: splitRadio, defaultPrevented: false,
    bubbles: false, preventDefault() {}, stopPropagation() {},
  });
  ok("the split starts at five share rows", qsa(root, ".custody-share-row").length === 5);
  setFieldValue(root, "custody-split-n", "10");
  ok("growing N adds fresh share rows", qsa(root, ".custody-share-row").length === 10);
  const grown = metas[metas.length - 1]!;
  ok("the grown sign-off list reaches the new share index", (grown.signoffs ?? []).some((s) => s.shareIndex === 10));

  // A share holder typed while that share's date is empty records the sign-off WITHOUT a
  // signedOn (the empty-date branch in upsertSignoff). Clear share 1's pre-filled date first.
  setFieldValue(root, "custody-share-dated-1", "");
  setFieldValue(root, "custody-share-holder-1", "Sam, Ops");
  const afterDateless = metas[metas.length - 1]!;
  const s1 = (afterDateless.signoffs ?? []).find((s) => s.shareIndex === 1);
  ok("a dateless share records the holder with no signedOn", s1?.holder === "Sam, Ops" && s1?.signedOn === undefined);

  // A share holder typed and then cleared, with the share's date filled, keeps the share's ruled row but
  // drops the date: the sheet prints a blank holder AND a blank date, never a date for nobody.
  setFieldValue(root, "custody-share-dated-2", "2026-09-24");
  setFieldValue(root, "custody-share-holder-2", "Kim, Legal");
  ok("a share with a holder carries its date", (metas[metas.length - 1]!.signoffs ?? []).find((s) => s.shareIndex === 2)?.signedOn === "2026-09-24");
  setFieldValue(root, "custody-share-holder-2", "");
  const s2 = (metas[metas.length - 1]!.signoffs ?? []).find((s) => s.shareIndex === 2);
  ok("a share holder cleared with the date set keeps no date", s2 !== undefined && s2.holder === "" && s2.signedOn === undefined);
}

// ---- summary ---------------------------------------------------------------------------------

verdictReached(failures);

if (failures > 0) {
  console.log(`\nCUSTODY-STEP COVERAGE: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nCUSTODY-STEP COVERAGE PASS");
