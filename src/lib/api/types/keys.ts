// Key-ceremony install mirror types. See ../types.ts for the barrel.

// KeyInstallInput is POST /admin/keys/install's wire shape: the in-browser key ceremony's output
// plus the ONE-SHOT scoped "Edit Cloudflare Workers" token the engine uses to write its OWN worker
// secrets (the no-customer-CLI replacement for `wrangler secret put`). The token and the private
// values are sent ONCE over the authenticated same-origin channel and never persisted client-side.
export interface KeyInstallInput {
  token: string;
  signerPrivate: string;
  breakGlassPublic: string;
  operationalPublic?: string;
  operationalPrivate?: string;
  // The configuration keys, sent on EVERY install (the engine refuses an install without them). The engine
  // keeps a configuration key it already holds rather than replacing it, and says so in the result.
  configRecipientPublic: string;
  configRecipientPrivate: string;
  configWrapKey: string;
  // confirmRekey is the DELIBERATE re-key acknowledgement. The engine's POST /keys/install refuses to install
  // over an ALREADY-PRESENT signer (which would reissue it and break signature verification of every prior run
  // receipt) UNLESS this flag is set, so a silent re-key is impossible. The console sets it ONLY from the
  // state-aware re-key card, after showing the signer-continuity warning; a first install omits it.
  confirmRekey?: boolean;
}

// ConfigRecipientOutcome mirrors the engine's outcome for the configuration recovery pair
// (CONFIG_RECIPIENT_PUBLIC + CONFIG_RECIPIENT_PRIVATE), which a failed second PUT can leave half-bound:
//   installed     this call wrote the pair. The engine holds it.
//   kept          the engine already held the full pair and left it in place. The engine holds it.
//   repaired      the engine held a lone private and this call wrote the public derived from it. The
//                 engine holds the full pair now; the request's own pair was validated but not written.
//   kept-partial  the engine held a lone half it cannot complete (a lone public, or a lone private that
//                 does not parse) and this call left it alone. The engine does NOT hold a working
//                 recovery key: its sealed configuration export is not readable by auto-heal. POST
//                 /admin/keys/add-config-recovery names the recovery step.
export type ConfigRecipientOutcome = "installed" | "kept" | "repaired" | "kept-partial";

// KeyInstallResult is the engine's redaction-safe response: the signer PUBLIC (safe, it is the
// recovery-sheet pin) and presence booleans. No token and no private value is ever echoed back.
// configWrapKey: "installed" when this call wrote the key, "kept" when the engine already held one and
// left it in place. configRecipient is the ConfigRecipientOutcome above: it is the one field where
// holding a key and holding a WORKING key are not the same fact, so a reader must not assume the engine
// holds a usable recovery key from "configured" alone.
// rewrap: what the engine's re-wrap pass did once the install put CONFIG_WRAP_KEY (engine admin/config-rewrap.ts
// RewrapReport). The console reads it, and never assumes it: a setup that stored the read-only token and a
// destination credential before the keys is sealed only when this block says ok with nothing left plaintext.
export interface KeyInstallResult {
  ok: boolean;
  signerPublic: string;
  configured: { signer: boolean; breakGlass: boolean; operational: boolean; configRecipient: ConfigRecipientOutcome; configWrapKey: "installed" | "kept" };
  rewrap?: ConfigRewrapReport;
  // runlogHandover rides only on a confirmed re-key (confirmRekey true). It is the hand-over of each
  // destination's backup RUNLOG from the old signer to the new one: see RunlogHandoverSummary below.
  runlogHandover?: RunlogHandoverSummary;
}

// RunlogHandoverOutcome is what the hand-over did with one destination's RUNLOG:
//   re-signed        it verified under the old signer and is now signed under the new one.
//   already-current  it already verified under the new signer; nothing changed.
//   absent           the destination has no RUNLOG yet; there is nothing to hand over.
//   pending          it did not verify under either key, or could not be read. It waits for the attended
//                    re-sign (POST /admin/runlog/resign) or a later hand-over under the held old key.
export type RunlogHandoverOutcome = "re-signed" | "already-current" | "absent" | "pending";

// RunlogHandoverSummary is the engine's report of a re-key's RUNLOG hand-over (POST /admin/keys/install with
// confirmRekey). `skipped` is set instead of `outcomes` when the outgoing signer could not be loaded at all
// (the repair case): every destination then waits for the attended re-sign, with no hand-over attempted.
// `pending` lists the destination ids still waiting. New runs are held while the hand-over is open.
export interface RunlogHandoverSummary {
  outcomes: Array<{ id: string; outcome: RunlogHandoverOutcome }>;
  pending: string[];
  heldKeyDiscarded: boolean;
  skipped?: "outgoing-signer-unreadable";
}

// RunlogSignatureState is the state GET /admin/runlog/signature reports a destination's RUNLOG in, under the
// engine's current signer:
//   verified          the stored .sig verifies the stored body. Nothing to decide.
//   pending-verifies  only the pending (write-resume) signature verifies. The next RUNLOG write resumes it;
//                      no Owner decision is needed.
//   sig-absent        there is no .sig object at all.
//   sig-invalid       a .sig is present but does not verify the stored body.
//   absent            there is no RUNLOG at this destination yet.
export type RunlogSignatureState = "verified" | "pending-verifies" | "sig-absent" | "sig-invalid" | "absent";

// RunlogSignatureView is GET /admin/runlog/signature's wire shape: what an Owner needs to decide whether an
// attended re-sign can help, and whether it would be safe. It promotes and signs nothing; it is a read.
export interface RunlogSignatureView {
  destinationId: string;
  object: string;
  signatureObject: string;
  present: boolean;
  sigPresent: boolean;
  pendingPresent: boolean;
  state: RunlogSignatureState;
  verifiesUnderHeldOld: boolean;
  digest?: string;
  parses: boolean;
  entryCount?: number;
  maxIndex?: number;
  chainAnomaly?: string;
  currentSigner: string;
  heldOldSigner?: string;
  handoverPending?: boolean;
  lastGoodIndex: number | null;
  canResign: boolean;
  refusal?: string;
}

// RunlogResignResult is POST /admin/runlog/resign's wire shape. "resumed" is the engine's own interrupted
// write, finished from the pending signature with no Owner decision; "re-signed" is the attended re-sign (or
// the re-key hand-over it can finish on the Owner's behalf).
export interface RunlogResignResult {
  ok: true;
  outcome: "resumed" | "re-signed";
  destinationId: string;
  state?: string;
  maxIndex?: number;
  lastGoodIndex?: number | null;
}

// RunlogFloorView is GET /admin/runlog/floor's wire shape: the destination's anti-rollback floor against the
// RUNLOG its bucket holds now. A redeploy that repoints DEST_R2 or DEST_* leaves the floor confirmed under
// the OLD bucket, so the writers refuse the new one (absent-above-floor or below-floor); this is the evidence
// for the one way out, an Owner-only floor reset. It promotes and signs nothing; it is a read.
export interface RunlogFloorView {
  destinationId: string;
  bucket: string;
  floor: number | null;
  runlogPresent: boolean;
  runlogState: string;
  digest?: string;
  maxIndex?: number;
  refusal?: string;
  canReset: boolean;
  resetTo?: number;
  // note rides only when the RUNLOG itself does not verify: a floor reset cannot help a RUNLOG the
  // attended re-sign (GET /admin/runlog/signature) has to decide first.
  note?: string;
}

// RunlogFloorResetResult is POST /admin/runlog/floor/reset's wire shape: the floor moved from oldFloor to
// newFloor (the highest index of the RUNLOG the bucket holds now, or 0 when it holds none), and reason names
// which refusal the reset cleared (absent-above-floor or below-floor).
export interface RunlogFloorResetResult {
  ok: true;
  outcome: "reset";
  destinationId: string;
  oldFloor: number | null;
  newFloor: number;
  reason: string;
}

// RunlogChainAnomaly mirrors the engine's closed chain-anomaly shape: the kind, the plain-English reason and,
// when the anomaly is two entries holding one index, the two disagreeing indices.
export interface RunlogChainAnomaly {
  kind: string;
  reason: string;
  indexA?: number;
  indexB?: number;
}

// RunlogChainView is GET /admin/runlog/chain's wire shape: one downpipe's chain within a destination RUNLOG
// that verifies under the engine's signer but still holds a chain anomaly for that downpipe (an older engine,
// or a control-plane loss). The append refuses to relink an anomalous chain itself, so this is the evidence
// for the one way out, an Owner-only, once-only relink. It promotes and signs nothing; it is a read.
export interface RunlogChainView {
  destinationId: string;
  downpipeId: string;
  bucket: string;
  present: boolean;
  verifies: boolean;
  digest?: string;
  maxIndex?: number;
  chainEntries?: number;
  anomaly?: RunlogChainAnomaly;
  relinkClears: boolean;
  lastGoodIndex: number | null;
  canRelink: boolean;
  refusal?: string;
}

// RunlogRelinkResult is POST /admin/runlog/relink's wire shape: acknowledged names the anomaly kind the
// relink cleared.
export interface RunlogRelinkResult {
  ok: true;
  outcome: "relinked";
  destinationId: string;
  downpipeId: string;
  acknowledged: string;
}

// ConfigRewrapReport mirrors the engine's RewrapReport: counts and closed class names, never a value or a key.
//   ok              true when no credential is left unencrypted
//   wrapped         credentials the pass encrypted
//   alreadyWrapped  credentials that were encrypted already
//   leftPlaintext   credentials the pass did not encrypt (they still work; their next save encrypts them)
//   failedClasses   the classes of those credentials (for example "discovery-token", "destination")
//   fault           why the pass could not run at all: the engine could not list them, or the key did not load
export interface ConfigRewrapReport {
  ok: boolean;
  wrapped: number;
  alreadyWrapped: number;
  leftPlaintext: number;
  failedClasses: string[];
  fault?: "census-failed" | "key-unusable";
}

// ConfigKeysAddInput is POST /admin/keys/add-config-recovery's wire shape: the one-shot token plus the
// configuration keys the engine LACKS (the recovery pair, the wrap key, or both). The engine refuses to
// replace a configuration key it already holds, so the console sends only the missing ones.
export interface ConfigKeysAddInput {
  token: string;
  configRecipientPublic?: string;
  configRecipientPrivate?: string;
  configWrapKey?: string;
}

// ConfigKeysAddResult is the engine's answer to POST /admin/keys/add-config-recovery. installed names
// the secrets this call wrote. configRecipient is present only when the call was asked to add the
// recovery pair: "installed" when it wrote a fresh pair, "repaired" when the engine held a lone private
// and this call wrote the public derived from it (the request's own pair was validated but not written).
// A lone public is refused before this result exists (the engine's dashboard-step sentence), so
// configRecipient here never reads "kept-partial".
export interface ConfigKeysAddResult {
  ok: true;
  installed: string[];
  configRecipient?: "installed" | "repaired";
  rewrap?: ConfigRewrapReport;
}

// CustodyShareSendInput is POST /admin/custody/send-share's wire shape: ONE Shamir share of the split
// break-glass wrapping key, emailed to one custodian over the operator's OWN outbound email. shareB64 is
// the raw 33-byte share (1 index byte + 32 payload) as base64url; the engine re-validates its length. n/m
// are the total shares and the reconstruction threshold (metadata for the email's honest framing). The
// ciphertext (the envelope over identity.key) is NEVER part of this body, so a captured share stays useless
// (ciphertext separation, S1). A single share below the threshold reveals nothing (Shamir).
export interface CustodyShareSendInput {
  toEmail: string;
  custodianLabel?: string;
  shareB64: string;
  n: number;
  m: number;
}

// CustodyShareSendResult is the engine's advisory outcome. sent:true means the send was accepted by the
// operator's email binding; sent:false carries a coarse, value-free reason (e.g. email-not-configured) the
// console surfaces so the operator learns WHY. Never echoes the share or the address.
export interface CustodyShareSendResult {
  sent: boolean;
  reason?: string;
  code?: string;
}

// ---- Key-vintage inventory (GET /admin/keys/vintages), mirrored from the engine's KeyVintageInventory ----
//
// A break-glass rotation writes only BREAK_GLASS_PUBLIC, so archives sealed before it stay wrapped to the
// OLD key and the engine cannot re-encrypt them. The keep-old-key warning on the Rotate tab says that; this
// inventory is what makes it CHECKABLE, by naming the vintages and counting the runs stranded to a key that
// is no longer installed. The engine derives every verdict from each run's signature-verified root manifest,
// read back keylessly, so no recorded index can fabricate a false "safe".
//
// CUSTODY: every field here is a PUBLIC dpr1:/edmldsa1: fingerprint, a closed role name or a count. No
// private half, seed or ciphertext exists in this shape, so no render of it can leak one.

// KeyVintageRollup is one distinct recipient key observed across the readable runs.
export interface KeyVintageRollup {
  fingerprint: string;
  role: string; // "break-glass" | "operational", the engine's closed role enum
  runCount: number;
  isCurrent: boolean; // whether this key is one the engine currently holds (so the next seal wraps to it)
}

// StrandedVintage attributes stranded runs to the prior vintage that seals them, so the surface can say
// "N runs from vintage <short fingerprint>" one line per vintage.
export interface StrandedVintage {
  fingerprint: string;
  role: string;
  runCount: number;
}

// KeyVintageInventory is the whole read. The two honesty discriminators matter on render: historyReadOk
// false means the run list could NOT be enumerated (so a zero count is "not read", never "nothing at
// stake"), and truncated means older runs went uninspected this pass. The console must never present
// either as an all-clear.
export interface KeyVintageInventory {
  current: { breakGlass: string | null; operational: string | null; signer: string | null };
  okRunCount: number;
  readableRunCount: number;
  truncated: boolean;
  historyReadOk: boolean;
  vintages: KeyVintageRollup[];
  stranded: { runCount: number; byVintage: StrandedVintage[]; unknownCount: number };
  signer: { current: string | null; brokenRunCount: number; currentRunCount: number };
  currentBreakGlassRunCount: number;
  operationalSoleAccessRunCount: number;
}
