// Coverage for src/components/custody-step.ts: the optional "keep the break-glass key safe
// offline" ceremony step. It renders the tier menu,
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
//   renderPaperCompanion           single-code and multi-code plans; chunk downloads; the
//                                   decode-fail branch warns and does not claim the copy is good.
//
// No-custody hygiene asserted: the onChange metadata for every tier carries only the scheme,
// the N/threshold and the custodian holders, never an identity byte, wrapping key, ciphertext
// or share body. The downloads are recorded locally by the test; nothing is logged.

import { installDomShim, qs, qsa, textOf, flushAsync, type ShimNode } from "../dom-shim.ts";

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

type CeremonyResult = import("../../src/keygen.ts").CeremonyResult;
type CustodyMetadata = import("../../src/lib/custody.ts").CustodyMetadata;

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
// This stub used to return void. Every test here therefore handed the component `undefined`, which it
// read as a refusal, so each of these cases has been rendering "Your browser did not deliver N of these
// files" while asserting nothing about it. The tests passed because none of them looks at delivery, so
// the mismatch was invisible from both sides.
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
  // Bound to a const so the four assertions below read a value that is known to be there. Previously they
  // reached through a non-null assertion, so a stub that was never called failed the line above and then
  // threw a TypeError on the next one. The throw here says WHICH thing did not happen.
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
// and the ciphertext is permanently unopenable. That is the failure this warning exists to prevent, and
// until now nothing tested it. Nothing could: the recorder returned void, so EVERY case in this file was
// hitting this path unnoticed, which is precisely why an untested branch stayed invisible.

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

// ---- 8. renderPaperCompanion: single-code, multi-code, and the decode-fail branch ------------

{
  // A small payload needs a single QR code; no chunk list is rendered, only the printable text.
  const { downloadText } = makeRecorder();
  const small = bytes.b64urlEncode(new Uint8Array(48).fill(9));
  const paper = renderPaperCompanion({ payloadB64: small, payloadLabel: "the encrypted key file", downloadText }) as unknown as ShimNode;
  ok("a small payload needs a single QR code", textOf(paper).includes("it needs 1 code"));
  ok("a single-code payload renders no chunk list", qs(paper, ".custody-qr-chunks") === null);
  ok("the printable text decodes cleanly", textOf(paper).includes("decodes cleanly"));
}

{
  // THE PRODUCTION PAYLOAD, derived from real code rather than a chosen constant. The paper companion
  // has exactly one caller (custody-step-panels.ts:191 doTier12Encrypt) and it is always handed
  // b64urlEncode of the AES-256-GCM ciphertext of identityPlaintext. Every valid identity.key is
  // exactly 96 bytes (lib/keydecap.ts parseIdentityFile refuses any other length, and
  // screens/keys/custody.ts applies that same parser to the file picker), so the payload is a fixed
  // 222 base64url characters against a QR_MAX_BYTES of 2,953 and the chunk branch below is
  // unreachable in production.
  //
  // A longer key format or a smaller per-code budget would make the single-code assumption above
  // quietly false (that case uses an arbitrary 48-byte payload); this block checks the real arithmetic
  // so a drift in either constant is caught here rather than assumed.
  const { downloadText } = makeRecorder();
  const prodPlaintext = custodyFiles.identityPlaintext(result);
  const prodEnvelope = await envelope.encrypt(prodPlaintext);
  const prodPayload = bytes.b64urlEncode(prodEnvelope.ciphertext);
  ok("the ceremony identity is the 96 bytes the restore path insists on", bytes.b64urlDecode(result.breakGlass.identityB64).length === 96);
  ok("the identity.key plaintext is 150 bytes", prodPlaintext.length === 150);
  ok("the production paper payload is 222 base64url characters", prodPayload.length === 222);
  ok("the production paper payload plans exactly one QR code", custodyLib.planQrChunks(prodPayload.length, custodyLib.QR_MAX_BYTES).total === 1);
  const prodPaper = renderPaperCompanion({ payloadB64: prodPayload, payloadLabel: "the encrypted key file", downloadText }) as unknown as ShimNode;
  ok(
    "no chunk download button renders for the production payload",
    qsa(prodPaper, '[data-dp="components-custody-paper.button.download-text"]').length === 0,
  );
}

{
  // A payload larger than one QR code's capacity needs several codes, each offered as a chunk
  // download. Use a payload well over QR_MAX_BYTES so plan.total > 1.
  const { downloads, downloadText } = makeRecorder();
  const big = bytes.b64urlEncode(new Uint8Array(custodyLib.QR_MAX_BYTES * 2 + 10).fill(3));
  const plan = custodyLib.planQrChunks(big.length, custodyLib.QR_MAX_BYTES);
  ok("the large payload plans more than one code", plan.total > 1);

  const paper = renderPaperCompanion({ payloadB64: big, payloadLabel: "the encrypted key file", downloadText }) as unknown as ShimNode;
  ok("a multi-code payload renders the chunk list", qs(paper, ".custody-qr-chunks") !== null);
  const chunkButtons = qsa(paper, ".custody-qr-chunk button");
  ok("there is one download button per chunk", chunkButtons.length === plan.total);

  // Downloading every chunk and concatenating recovers the whole payload (each chunk is a
  // slice; the operator feeds each to an offline QR tool). Order them by their index.
  for (const b of chunkButtons) b.click();
  const reassembled = downloads
    .filter((d) => /^qr-chunk-\d+-of-\d+\.txt$/.test(d.name))
    .sort((a, b) => Number(a.name.match(/^qr-chunk-(\d+)/)![1]) - Number(b.name.match(/^qr-chunk-(\d+)/)![1]))
    .map((d) => d.content.replace(/\n$/, ""))
    .join("");
  ok("the downloaded chunks reassemble to the full payload", reassembled === big);
}

{
  // The decode-fail branch: a payload that is NOT valid base64url makes b64urlDecode throw, so
  // the companion warns rather than claiming the printed copy is good.
  const { downloadText } = makeRecorder();
  const bad = "!!! not base64url @@@";
  const paper = renderPaperCompanion({ payloadB64: bad, payloadLabel: "the encrypted key file", downloadText }) as unknown as ShimNode;
  ok("an undecodable payload warns instead of claiming a clean copy", textOf(paper).includes("did not decode"));
  ok("the undecodable warning does not claim a clean decode", !textOf(paper).includes("decodes cleanly"));
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
}

// ---- summary ---------------------------------------------------------------------------------

if (failures > 0) process.exitCode = 1;

if (failures > 0) {
  console.log(`\nCUSTODY-STEP COVERAGE: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nCUSTODY-STEP COVERAGE PASS");
