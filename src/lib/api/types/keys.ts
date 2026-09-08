// Key-ceremony install mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

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
  // confirmRekey is the DELIBERATE re-key acknowledgement. The engine's POST /keys/install refuses to install
  // over an ALREADY-PRESENT signer (which would reissue it and break signature verification of every prior run
  // receipt) UNLESS this flag is set, so a silent re-key is impossible. The console sets it ONLY from the
  // state-aware re-key card, after showing the signer-continuity warning; a first install omits it.
  confirmRekey?: boolean;
}

// KeyInstallResult is the engine's redaction-safe response: the signer PUBLIC (safe, it is the
// recovery-sheet pin) and presence booleans. No token and no private value is ever echoed back.
export interface KeyInstallResult {
  ok: boolean;
  signerPublic: string;
  configured: { signer: boolean; breakGlass: boolean; operational: boolean };
}

// CustodyShareSendInput is POST /admin/custody/send-share's wire shape: ONE Shamir share of the split
// break-glass wrapping key, emailed to one custodian over the operator's OWN outbound email. shareB64 is
// the raw 33-byte share (1 index byte + 32 payload) as base64url; the engine re-validates its length. n/m
// are the total shares and the reconstruction threshold (metadata for the email's honest framing). The
// ciphertext (the envelope over identity.key) is NEVER part of this body, so a captured share stays useless
// (ciphertext separation). A single share below the threshold reveals nothing (Shamir).
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
