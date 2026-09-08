import type { Provider } from "./destinations.ts";
// Status / licence / run-history mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

export interface LicenceStatus {
  // The seven tier ids the platform mints:
  // Community (free) and Enterprise (bespoke services subscription) either side of the five
  // self-serve, estate-banded tiers, business-1/business-3/business-10/business-25 (buy directly)
  // plus msp (operator-mint only). The pre-9-August ids (starter, growth, a bare "business", msp as
  // a flat pack) are DELETED outright, not aliased: no-legacy, zero customers or tokens ever existed
  // under them. Display names are NOT a bare title-case of the id ("business-1" would read
  // "Business-1"; "msp" reads "MSP / MSSP"); screens/licence/../lib/billing.ts's tierDisplayName() is
  // the one place that maps every id (this map is display metadata only -- it never gates a feature).
  tier: "community" | "business-1" | "business-3" | "business-10" | "business-25" | "msp" | "enterprise";
  valid: boolean;
  notAfter?: string;
  reason?: string;
  // reasonCode is the engine's CLOSED discriminator for why a licence is not valid (engine
  // src/admin/licence.ts LicenceReasonCode). It rode on the wire unread until, and its absence
  // from this mirror is what made the expired-licence banner unreachable: `tier` is not a signal, because
  // the engine's fail-open path resolves EVERY one of these causes to "community", so the one customer
  // whose licence had expired was indistinguishable from a customer who had never bought one. `reason` is
  // the same fact as human prose and must not be parsed. This is the field to read.
  reasonCode?:
    | "no-token"
    | "no-pin"
    | "pin-invalid"
    | "segments"
    | "decode"
    | "signature"
    | "body-malformed"
    | "not-canonical"
    | "unparseable-expiry"
    | "future-tier"
    | "expired"
    | "internal-error";
  // features carries plain capability/band strings off the token: service flags ("restore-priority")
  // alongside the volume-licensing band a self-serve tier's token stamps -- "band:<tier>",
  // "estates:<n>", "protected-gb:<n>" (an msp licence may carry MULTIPLES of its base 1-estate/
  // 1,000 GB pack, e.g. estates:3 protected-gb:3000 for 3x). screens/licence/estate-band.ts parses
  // these defensively; a missing or malformed triple means the band sentence is simply withheld.
  features?: string[];
  // source is WHERE the active token came from: "console" = the DO-stored token an owner
  // activated through the portal (the no-CLI path), "deploy" = the env.LICENCE_TOKEN pinned at
  // deploy time. Omitted when the engine resolved no token at all (Community/none). It drives the
  // Licence card's activation control: a console-set token offers Replace/Remove; a deploy-set or
  // absent token offers Activate (paste). Redaction-safe: a coarse provenance enum, never the value.
  source?: "console" | "deploy";
  // setAt is the epoch-ms moment the console (DO-stored) token was activated; setBy is the verified
  // email of who activated it (console source only; null on the bare-token break-glass path). Both
  // are absent for a deploy-set or absent token. who/when only, no value, no key (no-custody).
  setAt?: number;
  setBy?: string | null;
  // accountClaimMatchesEngine is the engine's OWN verdict on whether the signed licence was minted for
  // THIS Cloudflare account: it compares the token's `account` claim against the engine's own account tag
  // (env.CF_ACCOUNT_ID) and sends a boolean, never the claim's value (engine src/admin/licence.ts
  // checkExpiry). false means the licence was issued for a DIFFERENT account. It is computed only when
  // both sides are known and only on a licence that verified and has not expired, so it is ABSENT
  // (honestly unknown) on an engine with no account tag configured, on an older engine, and on every
  // invalid or expired licence; absent is never read as a match. The engine does NOT enforce it: fail-open
  // is absolute, the licence is stored and the tier is reported either way, so this is a fact the console
  // must SAY, not a gate. See lib/billing.ts licenceAccountMismatch / LICENCE_ACCOUNT_MISMATCH_LINE.
  accountClaimMatchesEngine?: boolean;
  // estate is the measured-usage snapshot behind volume-based licensing: how much this account is
  // actually protecting right now, independent of what its licence band covers. null when the engine
  // has not yet computed one (e.g. no completed run); OPTIONAL (absent entirely, the same honest
  // `?:` convention as setBy above) on an engine build that predates this field, so an older engine
  // simply shows no estate line, never a fabricated one. Counts and byte totals only, no record
  // content, no destination credential (no-custody).
  estate?: EstateSummary | null;
}

// EstateSummary mirrors the engine's measured-estate snapshot byte-for-byte. totalProtectedBytes is
// the whole-account total the estate line and the over-band check both read; byType breaks the same
// total down by source-type id (mirrors the coverage surface's own type keys) for a future
// per-type view, unused by today's one-line estate summary. accounts/zones/downpipes are plain
// counts; asOf is the RFC-3339 instant the snapshot was taken (the same timestamp shape as
// notAfter/releasedAt elsewhere in this file).
export interface EstateSummary {
  totalProtectedBytes: number;
  accounts: number;
  zones: number;
  downpipes: number;
  byType: Record<string, { records: number; bytes: number }>;
  asOf: string;
}

// RunOpCounts mirrors the engine's per-run OpCounts (engine src/meter.ts): the exact metered Cloudflare
// operations a backup run made. subrequests is the grand total; the per-resource fields are the breakdown
// the cost platform ledger prices. r2ClassA is the R2 mutation class (PUT/part/LIST), r2ClassB the read
// class (GET/HEAD); cfApiRead/secretsRead are control-plane reads (rate-limited capacity, not billed data).
export interface RunOpCounts {
  kvRead: number;
  kvList: number;
  r2ClassA: number;
  r2ClassB: number;
  d1Read: number;
  cfApiRead: number;
  secretsRead: number;
  subrequests: number;
}

export interface RunHistoryEntry {
  runId: string;
  index: number;
  startedAt: string;
  // "abandoned" is a run the engine gave up on (an in-flight row the SRE alerting path retires rather than
  // leaving in flight forever). The engine has minted it for a long time and deliberately preserves it for the
  // console to display; this union carried only three members, so an abandoned run reached the map's enum guard
  // and was recorded as an UNKNOWN status -- a version-skew row for a current, legitimate engine state, sitting
  // in the same bucket as the genuine future-skew it was written to catch.
  status: "in-flight" | "ok" | "failed" | "abandoned";
  recordCount?: number;
  bytes?: number;
  error?: string;
  // Optional engine-reported counts added in the wire-shape extension; consumed by the cost
  // calculator (observed mode) and the topology map (throughput). All three are counts/sizes only,
  // never a secret or a key.
  archiveBytesWritten?: number;
  segmentsWritten?: number;
  durationMs?: number;
  // recordsIncomplete mirrors the engine's run-level incomplete-capture count (engine src/sched/types.ts
  // RunHistoryEntry): how many records this run SEALED as incompleteness sentinels (an in-scope record the
  // seal captured only partially, not a full copy). A non-zero count means the run completed but is NOT a
  // fully-captured backup, so the console must show it as a backup-completed-with-items-not-fully-captured
  // signal rather than a plain clean success. It is DISTINCT from recordsSkipped (a record that vanished or
  // changed mid-crawl behind an etag pin and was not sealed at all). Optional; ABSENT or 0 means a fully
  // captured run (honest absence on legacy rows and on an older engine, never fabricated). Count only,
  // never a secret or a key.
  recordsIncomplete?: number;
  // recordsSkipped mirrors the engine's per-run skip count (engine src/sched/types.ts RunHistoryEntry): how
  // many in-scope records the seal could NOT capture this run (a record that vanished or changed mid-crawl
  // behind an etag pin, an unsealable record). It is observability beside recordsIncomplete (a partial
  // capture): a non-zero count means the archive is intentionally short of the live source. Optional;
  // absent on legacy rows and on the buffered seal path. Count only, never a secret or a key.
  recordsSkipped?: number;
  // recordsVanished mirrors the engine's per-run vanished count (engine src/sched/types.ts RunHistoryEntry):
  // how many in-scope objects the LIST returned but that were GONE at value-read time (a KV key or R2 object
  // DELETED between the list page and the read, a mid-crawl live-source race). Like recordsSkipped it seals
  // nothing, so a non-zero count means the archive is short of the live source; DISTINCT from recordsSkipped
  // (an etag-changed object) and recordsIncomplete (a marker that DID seal). Optional; absent on legacy rows
  // and on a run with none. Count only, never a secret or a key.
  recordsVanished?: number;
  // prevRunId / prevRunIdStatus (F3) let the console reconstruct a downpipe's per-run predecessor
  // chain, mirroring engine src/admin/run-chain.ts annotatePredecessorChain. prevRunId is the SUCCESSFUL-
  // run predecessor this run chained from at allocation, or null when this is the downpipe's first run
  // ever. prevRunIdStatus is the engine's own honest verdict on that pointer, computed against the SAME
  // retained ring this row came from, so the console never has to guess or re-derive it:
  //   "none"     -- this IS the downpipe's first run (prevRunId is null).
  //   "retained" -- the predecessor's own row is present among the runs this read returned.
  //   "pruned"   -- a real predecessor exists but has aged out of the retained run-history window; this
  //                 is an honest truncation, NOT a broken or rewritten chain.
  //   "unknown"  -- the row was sealed before this field existed, so no predecessor pointer was recorded.
  // Both are ABSENT on an engine that predates this field (never fabricated; the console renders nothing
  // rather than guess). Redaction-safe: run ids only, the same class already carried by runId itself.
  prevRunId?: string | null;
  prevRunIdStatus?: "none" | "retained" | "pruned" | "unknown";
  // opCounts is the engine's EXACT per-resource metered-operation tally for the run (cost Phase 3): KV/R2/D1
  // reads, R2 writes, control-plane reads and the subrequest total. The cost calculator's platform ledger
  // ("cost to run the backup") consumes it for an exact figure, falling back to an estimate when absent
  // (legacy or buffered runs). Counts only, never a secret or a key.
  opCounts?: RunOpCounts;
  // The destination this run was SEALED to (the 3-2-1 failover-chosen origin); absent on legacy/failed rows.
  destinationId?: string;
  // sealVerification is the VERIFY-AT-SEAL verdict the engine records on each run row right after the
  // archive seals and BEFORE the run is reported a clean success (engine src/seal/verify-at-seal.ts
  // SealVerification, surfaced on the history row by engine src/admin/support.ts). The engine reads the
  // just-written archive back from the destination and verifies it, so a corrupt or partial backup is
  // caught at seal time rather than at the next periodic drill. It is FAIL-OPEN: a suspect verdict never
  // deletes or blocks; it only records the verdict and raises a posture finding. The console renders it
  // calmly per run. status is the only load-bearing flag ("verified" vs "suspect"); tier is the depth
  // that ran ("tier-0" the keyless chain attestation; "sampled-decrypt" additionally decrypt-checked a
  // sample; "full" decrypt-checked EVERY record, full byte coverage); sampled is how many records were
  // decrypt-checked (0 for tier-0; the full record count for the "full" tier); at is the epoch-ms the
  // verify ran; reason is a SHORT, coarse, secret-free note present ONLY on a suspect verdict. The field
  // is ABSENT on older runs sealed before verify-at-seal, which render nothing (honest absence, never a
  // fabricated pass). No value or key transits; it is a coarse verdict + counts only (no-custody).
  sealVerification?: {
    status: "verified" | "suspect";
    tier: "tier-0" | "sampled-decrypt" | "full";
    sampled: number;
    at: number;
    reason?: string;
    // tier0Cause is WHY a verified verdict ran only the keyless tier and skipped the keyed decrypt check.
    // A bare tier-0 cannot distinguish an intentional configuration from a misconfigured one, and every
    // remaining cause is something the operator can act on, so it is shown rather than left to support.
    // Set only on an intentional {verified, tier-0} verdict; absent on legacy rows and on any verdict that
    // did run the decrypt tier. A closed enum word, redaction-safe.
    tier0Cause?: "break-glass" | "sample-off" | "too-large" | "too-many-shards";
  };
}

// StatusReport is config-PRESENCE booleans for the onboarding poll, copied byte-for-byte
// from the engine's src/admin/status.ts so the two sides cannot drift. Presence is not
// validity: licenceConfigured/updateChannelConfigured report that the env vars are set,
// not that the licence is valid or the update channel verifies. The engine deliberately
// keeps this surface free of any secret value, fingerprint, destination credential, or
// licence verdict; destKind is the selected destination enum only.
export interface StatusReport {
  service: string;
  engineVersion: string;
  signerConfigured: boolean;
  breakGlassConfigured: boolean;
  operationalConfigured: { public: boolean; private: boolean };
  destConfigured: boolean;
  destKind: Provider | null;
  updateChannelConfigured: boolean;
  licenceConfigured: boolean;
  downpipeCount: number;
  // sourcesDetachedCount: how many configured source bindings are NOT currently present on the engine (a
  // deploy dropped them, or the resource was removed), so their downpipes' next runs fail. A count only
  // (never a binding name); present only when the engine computed it (a roster read succeeded), honestly
  // absent otherwise. The Overview reads it to surface a proactive "N sources need re-attaching" banner.
  sourcesDetachedCount?: number;
  ready: boolean;
  // auditNearCap mirrors the engine's StatusReport: true when the retained
  // audit-log count is at or above AUDIT_NEAR_CAP_FRACTION of AUDIT_CAP, so the UI can prompt an
  // export before the rollover begins. Honestly absent (exactOptionalPropertyTypes) when the engine
  // did not supply the count; never fabricated as false. Field name matches the engine exactly.
  auditNearCap?: boolean;
  // auditRolledOverCount is how many audit entries the retention rollover has ALREADY destroyed, and it is
  // here because auditNearCap alone cannot say. The retained count is pinned at exactly the cap from the
  // first rollover onwards, so the boolean reads true both when nothing has been lost and for ever
  // afterwards: an operator who can still export everything and one who lost a year of entries months ago
  // were shown the same warning and the same sentence, and that sentence told both of them to export now
  // to retain the full history. Honestly absent when the engine did not supply it, 0 when it did and the
  // log has never rolled. Field name matches the engine exactly.
  auditRolledOverCount?: number;
  // ---- Recovery-code / break-glass posture (mirrors the engine's StatusReport) ----
  // recoveryCodesRemaining is the CALLER'S OWN count of unconsumed single-use recovery codes (each one is
  // spent on use; regenerating mints a fresh 10 and invalidates the rest). The Security Centre shows it so
  // an operator knows when to regenerate; the recovery-codes-low posture finding fires off the same count.
  // bootstrapConsumed is true once the static bootstrap token has been used at least once (so the account
  // is past first-run). breakGlassTokenRetired is true once an Owner has disposed the bootstrap token
  // in-app (the retire control reflects this). tokenFallbackDisabled is true when the static-token sign-in
  // path is no longer accepted at all (retired AND no token configured). Each is HONESTLY ABSENT
  // (exactOptionalPropertyTypes) when an older engine did not supply it; never fabricated. Field names
  // match the engine exactly. None carries a value or a key; these are counts and booleans only.
  recoveryCodesRemaining?: number;
  bootstrapConsumed?: boolean;
  breakGlassTokenRetired?: boolean;
  tokenFallbackDisabled?: boolean;
  // ---- Credential lifecycle registry (mirrors the engine's StatusReport) ----
  // expiryWarnings is the count of FUNCTIONAL credentials approaching or expired; cleanupPending is the
  // count of EPHEMERAL spent tokens awaiting the operator's deletion confirmation. Both honestly absent
  // (exactOptionalPropertyTypes) when the engine did not supply them; never fabricated. The single nav
  // count chip on /credentials surfaces their sum. Neither carries a value or a key, counts only.
  expiryWarnings?: number;
  cleanupPending?: number;
  // demoMode is true ONLY on a throwaway demo engine (the DEMO_MODE flag). The console shows the "Reset
  // demo to fresh" affordance only when this is true; on a real engine it is false/absent and the reset
  // route does not exist (404). Presence-only, never a secret.
  demoMode?: boolean;
  // ---- Release provenance descriptors (mirrors the engine's StatusReport) ----
  // artefactSha384 is the engine's SELF-STAMPED build-id digest of its own deployable bundle (src/format/
  // build-id.ts, written at build): the REAL hash, replacing the old hardcoded "not yet reported" placeholder.
  // releaseSignerPin is the public release-signer pin. Both are PUBLIC build identifiers (a digest and a pin),
  // never a key half. Honestly ABSENT (exactOptionalPropertyTypes) on an UNSTAMPED build (a non-release/dev
  // checkout) or an older engine, the console then keeps an honest "not reported", never a fabricated value.
  artefactSha384?: string;
  releaseSignerPin?: string;
  // cfAccountId is the engine's own Cloudflare account id
  // (env.CF_ACCOUNT_ID), mirrored so the Licence screen's claim exchange can send it with a claim code
  // (screens/licence/claim-code.ts fetchClaimToken) and the control plane can bind the self-serve
  // licence to it. This is the customer's OWN account id, not a secret. Honestly absent (the common
  // single-account deployment never sets CF_ACCOUNT_ID, and an older engine predates this field
  // entirely): the claim then sends no account id, exactly as it did before this field existed.
  cfAccountId?: string;
}

export interface DrillResult {
  ok: boolean;
  runId: string;
  recordsVerified?: number;
  sampleRestored?: boolean;
  isLatest?: boolean;
  reason?: string;
}

// ---- Require-Access pre-flight (POST /admin/policy/require-access), mirrored from the engine ----
//
// Disabling the shared admin token, or deleting its secret, is an OUT-OF-BAND act the engine cannot
// intercept. So the engine offers an authoritative verdict the console consults BEFORE it advises the
// operator to do it: safeToDisableToken is true only when a second factor exists AND this caller is not
// itself on the bare token (disabling it mid-session would strand even them). When it is false the engine
// supplies lockoutWarning, which the console surfaces VERBATIM rather than paraphrasing a safety verdict.
//
// It is a read that happens to be a POST: the engine stores nothing and echoes nothing the operator did not
// already configure. Booleans plus the caller's own auth method, never a token, an email or any secret.
export interface RequireAccessPreflight {
  // tokenFallbackDisabled mirrors StatusReport.tokenFallbackDisabled exactly: the shared-token sign-in path
  // is no longer accepted. accessConfigured is whether Cloudflare Access is wired (team domain AND AUD).
  tokenFallbackDisabled: boolean;
  accessConfigured: boolean;
  // enforced is the safe-to-rely-on state: the token fallback is closed AND Access is actually configured.
  // A disabled token with no Access is a lock-out the engine already fails closed on, reported enforced:false.
  enforced: boolean;
  // callerMethod is how THIS caller authenticated, so the console never offers the disable to a caller on
  // the bare-token break-glass path.
  callerMethod: string;
  // secondFactor names the four ways back in separately, so the console can say WHICH one to arrange rather
  // than only that none exists. secondFactorPresent ORs them.
  secondFactor: { passkeyOwnerEnrolled: boolean; accessConfigured: boolean; recoveryReady: boolean; secondOwner: boolean };
  secondFactorPresent: boolean;
  safeToDisableToken: boolean;
  lockoutWarning: string | null;
}
