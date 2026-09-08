// Support (diagnostics / audit-feed) mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// ---- Support mirror (engine/src/admin/support.ts + router GET/POST /support*) ------------
// The supportability surface: the vendor-seal presence, the redacted per-scope ingest-credential
// grants, and the mint response. The ONE secret in this family (the minted credential secret)
// appears EXACTLY ONCE, in MintedSupportCredential; the grant views carry no secret and no hash.

// IngestScope mirrors the engine's IngestScope: "diagnostics" lets vendor support pull the
// signed bundle from GET /support/diagnostics during a ticket; "audit-feed" lets the customer's
// SIEM collector poll the hash-chained audit events from GET /support/audit-feed; "metrics" lets a
// Prometheus-compatible scraper (Prometheus, Grafana, the Datadog/New Relic/Dynatrace/Elastic/
// Splunk Observability agents, Grafana Cloud's agentless scraper) pull the text-exposition metrics
// surface from GET /metrics.
export type IngestScope = "diagnostics" | "audit-feed" | "metrics";

// SupportGrantView is the engine's redactGrant() output for one scope: the non-secret clientId,
// the scope, who granted it and when, the expiry plus a computed expired flag, and every
// recorded pull (the customer-visible usage trail). Never the secret and never its hash.
// grantedBy is null for the bare-token grant path (unattributable break-glass).
//
// expiryUnreadable is the THIRD state, and the reason it rides beside `expired` rather than replacing
// it. The engine's stored expiresAt can be a value that does not parse (a corrupted write, a half-flushed
// storage page, a hand-edited record: engine/src/admin/support-shared.ts grantExpiryState). Such a grant
// is REFUSED at the pull gate, so `expired` answers true, which is the question every existing reader is
// asking ("is this credential still usable"). But it did not expire, and the console must not say it did:
// expiryUnreadable is what lets this surface say the third thing instead of the coarse one.
// OPTIONAL, and PRESENT ONLY IN THE THIRD STATE (engine support-ingest.ts redactGrant spreads it in
// behind `expiry.readable ? {} : ...`), so absent means readable and must never be read as a warning.
// The console never re-derives this from expiresAt: parsing that string here is the exact NaN-blind
// comparison the engine has just removed, and a second derivation could disagree with the gate.
export interface SupportGrantView {
  clientId: string;
  scope: IngestScope;
  grantedAt: string;
  grantedBy: string | null;
  expiresAt: string;
  expired: boolean;
  expiryUnreadable?: boolean;
  pulls: { at: string }[];
}

// SupportStatus is the GET /admin/support body. vendorSealConfigured reports whether
// VENDOR_SUPPORT_PUBLIC is set (bundle sealed to the vendor key vs signed only);
// signerConfigured reports whether the key ceremony has run (a pre-ceremony engine serves the
// bundle UNSIGNED and the copy must say so); diagnostics / auditFeed are the per-scope grant
// views, null when no credential is active for that scope.
// accessPerimeter reports whether the engine saw the edge-injected cf-access-jwt-assertion header
// on this read: Cloudflare Access fronts the hostname, so the out-of-band /support/* pulls (and the
// top-level GET /metrics scrape) will be turned away at the edge without an Access service token or
// a path-scoped exemption. A hint the mint UI warns from, never authority. OPTIONAL because engines
// earlier than 0.1.5 do not send it; absent must render as "unknown", never as a warning.
// metrics is the "metrics"-scope grant view, mirroring diagnostics/auditFeed. OPTIONAL (unlike those
// two) because it is a NEWER field: an engine that predates the monitoring build omits it entirely,
// which must render as "no active credential", never as a broken or missing scope.
export interface SupportStatus {
  vendorSealConfigured: boolean;
  signerConfigured: boolean;
  accessPerimeter?: boolean;
  diagnostics: SupportGrantView | null;
  auditFeed: SupportGrantView | null;
  metrics?: SupportGrantView | null;
}

// MintedSupportCredential is the POST /admin/support/credentials response. The secret (and its
// single-bearer form "<clientId>.<secret>") appears HERE, EXACTLY ONCE: the engine stores only
// the SHA-384, so this response is the only time it can be copied. note restates that.
export interface MintedSupportCredential {
  scope: IngestScope;
  clientId: string;
  secret: string;
  bearer: string;
  expiresAt: string;
  note: string;
}
