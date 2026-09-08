// The CLOSED, STABLE refusal vocabulary for the two disaster-recovery paths: recovering the control plane
// from a signed export (the break-glass reconcile) and importing an estate onto a fresh engine.
//
// Why a code at all. These flows run exactly when the engine is fresh or wiped, so the durable audit ring
// the rest of the product leans on is EMPTY, and a support pack may not be buildable at all. The refusal the
// operator is looking at may be the only witness there is. A prose sentence is not a witness: the customer
// paraphrases it down the phone ("it says something about the signature"), and support cannot tell a bad
// signer.pub from a bad signature from a plane that was not empty. A short, stable code is one the customer
// can read out verbatim, and it maps to exactly one branch of exactly one gate.
//
// The code is DISPLAY ONLY. Nothing here is transmitted, persisted or beaconed: it is stamped into the copy
// the operator is already reading. It carries no customer value by construction (each is a compile-time
// constant), so quoting one over an unencrypted channel discloses nothing.
//
// The codes are an API to the support desk and to the docs: they are STABLE. Never renumber one, never
// recycle a retired one, and never widen a code to cover a second branch. Add a new code instead.

export const RECOVERY_REFUSAL_CODES = [
  // Client-side rejections. These never reach the engine, so the engine cannot record them and the code in
  // front of the operator is the ONLY trace that exists.
  "DP-R01", // the export field was left empty
  "DP-R02", // the pasted export is not valid JSON
  "DP-R03", // the JSON parsed, but it is neither a v:1 plaintext control-plane export nor a v:1 SEALED one (the estate-import paste now admits both shapes)
  "DP-R04", // the detached signature was left empty
  "DP-R05", // the recovery-kit signer.pub was left empty (estate import only)
  "DP-R06", // the break-glass token was left empty (control-plane reconcile only)
  // Engine-side refusals, keyed to the status the engine answered with. The engine's own reason is shown
  // alongside; the code pins WHICH gate refused even when that reason is paraphrased or lost.
  "DP-R10", // 401: the break-glass token (ADMIN_TOKEN) was not accepted
  "DP-R11", // 403: the caller is not an Owner
  "DP-R12", // 400: refused at verification (signature, signer mismatch, shape, no-custody, plane not empty)
  "DP-R13", // any other non-2xx, or the engine could not be reached
  "DP-R14", // the export download returned no signed export (a missing signer, or a malformed answer)
  // DP-R12 used to be EVERY 400, so signature, shape-check and no-custody were one code and one coalesced
  // row. The engine now returns a CLOSED refusalClass in its 400
  // body (refusalClassToCode below admits it by set membership) and these three split it.
  "DP-R15", // 400: the export's detached SIGNATURE did not verify (wrong signer, or an altered export). This is the ONLY code a tamper can reach
  "DP-R16", // 400: the artefact FAILED THE SHAPE CHECK at the engine (it parsed; it is not an estate export)
  "DP-R17", // 400: the NO-CUSTODY GATE refused it -- the artefact carries a plaintext secret
  // G202: DP-R15 used to be all FOUR verify verdicts, which breaks this file's own rule that a code never covers
  // a second branch. The engine verifies BOTH halves of the hybrid signature over the SAME export bytes, so a
  // failure that leaves either half verifying PROVES the export intact and puts the damage in the operator's own
  // kit. Reading that out as DP-R15 told a customer their disaster-recovery artefact had been tampered with when
  // the remedy was "take another copy of your recovery kit", on the one path where the artefact in front of them
  // may be the only one left. One branch, one code:
  "DP-R18", // 400: the CLASSICAL half of the signature did not verify and the POST-QUANTUM half DID, over these exact export bytes. The export is INTACT and the Ed25519 half of the kit (the signer.pub, or the .sig) is damaged. Take a fresh copy of the kit. NOT tamper, which cannot break one half and leave the other
  "DP-R19", // 400: the detached signature BLOB would not decode (a truncated / half-written .sig), so the export was never checked at all. Take a fresh copy of the signature. NOT tamper
  "DP-R20", // 400: the KEY would not import at all, so the export was never checked at all. Take a fresh copy of the kit's signer.pub. NOT tamper
  "DP-R21", // 400: the POST-QUANTUM half did not verify and the classical half DID, over these exact export bytes. The export is INTACT: a partial / mixed signer rotation, or a rotted ML-DSA half of the kit key. NOT tamper
  // "Open a sealed export" (lib/sealed-export-unseal.ts). DP-R15/18/19/20/21 above are REACHABLE from
  // this flow too (the sealed wrapper's own signature is verified locally, byte-identical to the engine's own
  // check, before anything is decrypted): same meaning, caught one round-trip earlier, in the BROWSER rather
  // than the 400 body. These seven are states of browser-side unseal: only a browser holding the private
  // break-glass identity can ever observe them on the ESTATE-IMPORT path (that engine holds no key that opens
  // a sealed artefact it did not seal itself), so none of them has a plaintext-import equivalent. Two of the
  // seven acquired an on-the-wire twin; see DP-R29/DP-R30 below for why the twin is a separate code
  // rather than a reuse of these.
  "DP-R22", // client-side: the sealed artefact's version is one this browser's unseal does not understand
  "DP-R23", // client-side: the sealed artefact predates bodyHash and cannot be cross-checked, so it is refused rather than trusted unverified
  "DP-R24", // client-side: no capsule wrap matches the held identity -- the WRONG break-glass key (or quorum) for this estate
  "DP-R25", // client-side: the capsule addressed to the held identity did not decrypt cleanly -- a corrupt or truncated sealed artefact
  "DP-R26", // client-side: the sealed BODY did not decrypt cleanly, after a good capsule open -- a corrupt or truncated sealed artefact
  "DP-R27", // client-side: the body decrypted, but is not a valid control-plane export
  "DP-R28", // client-side: the recovered plaintext's hash does not match the SIGNED bodyHash (should never occur once the signature and both AEAD opens already succeeded; refused rather than silently trusted)
  // the ENGINE-SIDE twins of DP-R23 and DP-R28, reachable only on POST /admin/control-plane/restore-sealed,
  // where the engine opens the sealed artefact itself (engine src/admin/router-identity.ts, the `reconcile-sealed`
  // surface, which answers these two classes by name). On the estate-import path the browser always gets there
  // first, so the two above are the only ones an operator sees; on THIS route the console's local pre-check can be
  // bypassed or race, and the engine is entitled to answer either.
  //
  // SEPARATE CODES, NOT A REUSE, and the reason is this file's own one-branch-one-code rule. DP-R23/DP-R28 assert
  // something the engine-side pair cannot: that THIS BROWSER, holding the private break-glass identity, opened the
  // artefact and found the fault locally. The engine-side pair asserts only that the engine refused. Same remedy
  // for the operator, different thing proved, and the diagnostics ring keys on the code, so fusing them would make
  // a local refusal and a wire refusal one indistinguishable row -- exactly the G196 defect that split DP-R12.
  "DP-R29", // 400 on restore-sealed: the ENGINE refused a sealed artefact that predates bodyHash, so it cannot be cross-checked (the wire twin of DP-R23)
  "DP-R30", // 400 on restore-sealed: the ENGINE recovered the plaintext and its hash does not match the SIGNED bodyHash (the wire twin of DP-R28)
  // Defect 23: the ACKNOWLEDGE-ONLY latch clear (POST /admin/control-plane/acknowledge-recovery), the one exit
  // an established account has. Its refusals get their own codes rather than reusing DP-R11/DP-R12, and the
  // reason is this file's own one-branch-one-code rule twice over. DP-R11 says "the caller is not an Owner",
  // which is wrong here in both directions: access-admin can acknowledge, and the break-glass token, which
  // holds owner everywhere else, is refused by name on this route alone. DP-R12 is a VERIFICATION refusal over
  // an artefact, and there is no artefact on this call at all.
  "DP-R31", // 400 on acknowledge-recovery (engine class ack-role-table-empty): the estate's role table is empty, so clearing the latch would remove the only explanation for every caller resolving to viewer. NOT a wiped-plane refusal, and the remedy is a role grant, not an export
  "DP-R32", // 400 on acknowledge-recovery (engine class ack-no-latch): there was no recovery in effect by the time the acknowledge arrived. Benign: another operator, another tab or a reconcile cleared it first, and the banner is already down
  "DP-R33", // 403 on acknowledge-recovery: this caller does not hold access.policy, or is the bare break-glass token, which this route refuses BY DESIGN (an owner who can authenticate at all means the role table is non-empty, so there is always a real owner to ask)
] as const;

export type RecoveryRefusalCode = (typeof RECOVERY_REFUSAL_CODES)[number];

// withRefusalCode stamps the code onto the message the operator sees, in a fixed, greppable position (the
// tail, in parentheses) so a customer reading it out, a screenshot, and a docs page all agree on where it
// is. The message is never rewritten, only suffixed.
export function withRefusalCode(message: string, code: RecoveryRefusalCode): string {
  return `${message} (${code})`;
}

// refusalCodeForStatus maps the engine's HTTP status to its refusal code. TOTAL: every status yields a
// member of the closed set, so there is no path on which the operator sees an uncoded refusal.
export function refusalCodeForStatus(status: number): RecoveryRefusalCode {
  if (status === 401) return "DP-R10";
  if (status === 403) return "DP-R11";
  if (status === 400) return "DP-R12";
  return "DP-R13";
}

// ---- the engine's 400 sub-cause (G196) --------------------------------------------------------------------

// ENGINE_REFUSAL_CLASSES mirrors the engine's own frozen RECOVERY_REFUSAL_CLASSES (engine
// src/admin/diag-records.ts). It exists because DP-R12 WAS EVERY 400: refusalCodeForStatus maps a status to a
// code, and the engine answers 400 for a bad signature, a failed shape check, a no-custody refusal and a plane
// that was not empty alike. The ticket's own list -- "wrong token vs signature vs shape vs no-custody vs
// not-Owner" -- therefore had three of its five states fused into ONE row that coalesced on the ring's tuple key,
// and support could not tell a tampered export from a hand-edited one from a wrong kit.
//
// THE CONSOLE MUST NOT GUESS THIS FROM PROSE. The engine's 400 message can name a bucket or a key, and a
// classifier over a sentence the console does not own mislabels the moment the engine rewords itself. So the
// ENGINE now returns a CLOSED `refusalClass` member in its 400 body, and the console admits it ONLY by SET
// MEMBERSHIP against this frozen list. A body carrying anything else -- an older engine that sends none, or a
// hostile one that sends a customer value -- falls back to DP-R12, so the mapper stays total, the code stays a
// compile-time constant, and nothing from the wire can ever become one.
const ENGINE_REFUSAL_CLASS_SET: ReadonlySet<string> = new Set([
  "signature",
  "signature-pq",
  "classical-half-damaged",
  "verify-threw",
  "verifier-invalid",
  "malformed",
  "shape",
  "no-custody",
  "no-signer",
  "build-failed",
  "reconcile-refused",
  "staged-malformed",
  // the two classes the engine's `reconcile-sealed` surface answers by name
  // (engine src/admin/router-identity.ts). Admitted here so a refusal from
  // POST /admin/control-plane/restore-sealed reaches its own code instead of coalescing into DP-R12.
  "sealed-unhashed",
  "sealed-body-mismatch",
  // Defect 23: the two classes the ACKNOWLEDGE route answers by name
  // (engine src/admin/router-control-plane-recovery-ack.ts). Admitted here so a refusal on the one exit an
  // established account has reaches its own code instead of coalescing into DP-R12, which is a VERIFICATION
  // code over an artefact this call does not carry.
  "ack-role-table-empty",
  "ack-no-latch",
]);

// REFUSAL_CLASS_TO_CODE maps each admitted engine class to the operator-facing code. The classes the gap names get
// their own code; the rest stay on DP-R12, which is honest (they are 400s whose sub-cause the operator cannot act
// on differently) and keeps the code list from growing a member per engine branch.
//
// The five verify verdicts DO NOT collapse to one code, because the operator's action is NOT the same. Both halves
// of the hybrid signature cover the same bytes, so the half that still verifies is a proof about the export:
//
//   signature        NEITHER half verified: the wrong key, or the export was ALTERED. Tamper lives here alone,
//                    and the remedy is to distrust the artefact. DP-R15.
//   classical-half-damaged  the post-quantum half verified THESE EXACT export bytes and the classical half did
//                    not, so the EXPORT IS PROVABLY INTACT and the Ed25519 half of the kit is damaged. The remedy
//                    is to take another copy of the kit, the OPPOSITE of distrusting the artefact. DP-R18.
//   signature-pq     the mirror image: the classical half verified and the post-quantum half did not. The export
//                    is intact and the ML-DSA half of the kit is damaged, or the signer was partially rotated,
//                    which is a different thing to go and check. DP-R21.
//   verify-threw     the .sig blob would not decode: re-copy the SIGNATURE. DP-R19.
//   verifier-invalid the key would not import: re-copy the KEY. DP-R20.
//                    Neither of those last two checked the export at ALL, so they assert nothing about it.
const REFUSAL_CLASS_TO_CODE: Readonly<Record<string, RecoveryRefusalCode>> = {
  signature: "DP-R15",
  "classical-half-damaged": "DP-R18",
  "signature-pq": "DP-R21",
  "verify-threw": "DP-R19",
  "verifier-invalid": "DP-R20",
  shape: "DP-R16",
  malformed: "DP-R16",
  "no-custody": "DP-R17",
  // Deliberately NOT DP-R23/DP-R28: those two assert that this browser opened the artefact and found
  // the fault locally, which a wire refusal does not prove. See their entries in RECOVERY_REFUSAL_CODES.
  "sealed-unhashed": "DP-R29",
  "sealed-body-mismatch": "DP-R30",
  // Defect 23. Two branches, two codes, opposite next steps: DP-R31 needs an owner role granted with the
  // break-glass token before the acknowledge can be taken at all, and DP-R32 needs nothing done, because the
  // banner it was trying to clear is already down.
  "ack-role-table-empty": "DP-R31",
  "ack-no-latch": "DP-R32",
};

// refusalClassToCode is the TOTAL, PURE mapper from the engine's 400-body refusalClass to a frozen DP-R code. It
// reads an untrusted string, tests it for SET MEMBERSHIP, and RETURNS a compile-time constant. The input string is
// never carried, never suffixed onto a message and never stored: a customer value smuggled into this field cannot
// be a set member and yields DP-R12, exactly as an absent field does.
export function refusalClassToCode(refusalClass: unknown): RecoveryRefusalCode {
  if (typeof refusalClass !== "string" || !ENGINE_REFUSAL_CLASS_SET.has(refusalClass)) return "DP-R12";
  return REFUSAL_CLASS_TO_CODE[refusalClass] ?? "DP-R12";
}
