// Config version-history mirror types, split out of ../types.ts (move-only barrel pattern). See
// ../types.ts for the barrel. These mirror the engine's read-only config-history surface (engine
// src/admin/config-history.ts + src/admin/config-snapshot.ts + src/admin/config-diff.ts, served via the
// scheduler DO behind GET /admin/config/history, GET /admin/config/version, GET /admin/config/diff and
// POST /admin/config/snapshot). The console renders this history; it never re-derives a hash, a diff or a
// verdict (the engine is the authority). No-custody: every field here is an id, a timestamp, an author
// email, a redaction-safe summary/diff line, or a hash label; never a secret value or a key.

// ---- The history list row (GET /admin/config/history) -------------------------------------------
// One version's REDACTION-SAFE header, newest-first in the list. The full normalised snapshot is fetched
// separately (GET /admin/config/version?id=N) so the list stays light. parentHash/contentHash are the
// chain links the engine's verify recomputes; the console shows them as opaque labels for context.
export interface ConfigVersionHeader {
  readonly id: number;
  readonly at: string; // RFC-3339 UTC the version was captured
  readonly author: string | null; // the verified email that triggered the capture, or null for break-glass/internal
  readonly parentHash: string; // "sha384:..." (the prior version's contentHash, or the genesis sentinel)
  readonly contentHash: string; // "sha384:..." commits to the exact posture at this version
  readonly summary: string; // the engine's plain-English (Australian) one-line auto-summary of the change
}

// ConfigChainVerdict mirrors the engine's verifyConfigChain verdict: whether the recomputed hash chain
// and signed digests are intact, the highest id checked (the head), the lowest id checked (the baseline,
// which may be above 1 after a documented retention rollover), and the first id whose hash/digest/link/
// contiguity fails when not intact. The console shows this as an honest badge, never as a re-derived claim.
//
// headTruncated is the one break `intact` cannot report. The recompute runs over the versions the engine
// still holds, so deleting the NEWEST ones leaves the rest linking cleanly and intact reads TRUE. The engine's
// head anchor (committed in the same storage turn as each version, never lowered by a rollover) catches it, and
// its verdict now rides on this body: a history whose head was deleted must never render as "Chain verified".
export interface ConfigChainVerdict {
  readonly intact: boolean;
  readonly checkedThrough: number; // the head id, or -1 for an empty history
  readonly earliestId: number; // the baseline id, or -1 for an empty history
  readonly brokenAt?: number; // present only when intact is false: the first broken version id
  readonly headTruncated?: boolean; // the retained head sits BELOW the head the engine committed to: versions were deleted
  readonly headTruncatedAt?: number; // the version id the engine's anchor committed to
}

// ConfigHistory is the whole GET /admin/config/history body: the newest-first version headers, the chain
// head (id + hash), and the verify verdict over the full retained chain.
export interface ConfigHistory {
  readonly versions: ConfigVersionHeader[];
  readonly headId: number; // the head version id, or -1 when the history is empty
  readonly headHash: string; // the head contentHash, or the genesis sentinel when the history is empty
  readonly verify: ConfigChainVerdict;
}

// ---- One full version (GET /admin/config/version?id=N) ------------------------------------------
// ConfigVersion is the full stored record: the header fields plus the signed digest and the full
// normalised snapshot. The console shows the snapshot read-only: there is no config rollback endpoint;
// the snapshot is the
// redaction-safe posture projection (secrets carried by NAME only, credentials by a presence boolean),
// so it is kept structurally loose here and rendered defensively (the diff is the operator-facing payoff).
export interface ConfigVersion extends ConfigVersionHeader {
  readonly digest: string; // "edhmac384:..." the DO-local signature over the chain-bound fields
  readonly snapshot: ConfigSnapshotMirror;
}

// ConfigSnapshotMirror is the normalised posture projection the engine stores per version. It is modelled
// LOOSELY on purpose: the console does not re-derive anything from it (the diff endpoint is the readable
// view of what changed), and a newer engine adding a versionable family must not break the older console.
// Every member is redaction-safe by construction on the engine side (snapshotConfig copies named,
// non-secret fields only); the console renders only the counts and the diff, never a raw value.
export interface ConfigSnapshotMirror {
  readonly downpipes: unknown[];
  readonly roles: unknown[];
  readonly groupRoles: unknown[];
  readonly customRoles: unknown[];
  readonly notifyChannels: unknown[];
  readonly notifyRules: unknown[];
  readonly webhook: { readonly configured: boolean; readonly host: string | null };
  readonly riskAccepts: unknown[];
  readonly expiryItems: unknown[];
  readonly coverage?: unknown;
}

// ConfigVersionResult is the discriminated GET /admin/config/version body: an unknown/absent id returns
// { found: false } (the console shows "version not found"); a known id returns the full version.
export type ConfigVersionResult = { readonly found: false } | { readonly found: true; readonly version: ConfigVersion };

// ---- The plain-English diff (GET /admin/config/diff?from=A&to=B) --------------------------------
// ConfigDiffArea is the versionable family a diff line belongs to, so the console can group/icon a line
// without re-parsing its text. Mirrors the engine's ConfigChange.area; rendered defensively (an unknown
// area from a newer engine still renders with the line's text).
export type ConfigDiffArea =
  | "downpipe"
  | "role"
  | "group-role"
  | "custom-role"
  | "notify-channel"
  | "notify-rule"
  | "risk-accept"
  | "expiry"
  | "coverage";

// ConfigDiffKind tags a line added / removed / changed (the engine's ChangeKind), for an icon/colour cue.
export type ConfigDiffKind = "added" | "removed" | "changed";

// ConfigDiffLine is one plain-English (Australian) change between two versions. text is the engine's
// pre-rendered one-liner (e.g. "downpipe kv:sessions added"); the console renders it as a TEXT NODE.
export interface ConfigDiffLine {
  readonly kind: ConfigDiffKind;
  readonly area: ConfigDiffArea;
  readonly text: string;
}

// ConfigDiffResult is the discriminated GET /admin/config/diff body: an unknown/absent from or to returns
// { found: false }; otherwise the change list between the two versions (from -> to as given).
export type ConfigDiffResult =
  | { readonly found: false }
  | { readonly found: true; readonly from: number; readonly to: number; readonly changes: ConfigDiffLine[] };

// ---- The manual snapshot result (POST /admin/config/snapshot) -----------------------------------
// ConfigSnapshotResult is the POST /admin/config/snapshot body: { created: false } when the posture was
// unchanged since the head (the engine de-dupes, so a no-op snapshot does not churn a version), else the
// new version's id/at/summary so the console can confirm what it captured.
export type ConfigSnapshotResult =
  | { readonly created: false }
  | { readonly created: true; readonly id: number; readonly at: string; readonly summary: string };
