// Credential & key expiry tracker mirror types, split out of ../types.ts (move-only). See ../types.ts for the barrel.

// Credential & key expiry tracker, mirrored byte-for-byte. An item /
// status carries a redaction-safe label and a date only; never the secret itself.

// ExpiryKind is the class of the tracked item. "token" is the ephemeral Cloudflare/portal token class.
export type ExpiryKind = "credential" | "key" | "licence" | "certificate" | "token";

// ExpiryLifecycleClass is the retention INTENT (orthogonal to kind): "ephemeral" = a one-shot token to
// DELETE after use; "functional" = a standing credential the platform keeps using.
export type ExpiryLifecycleClass = "ephemeral" | "functional";

// UsageLink is what a credential powers (so the row/drawer can show "used for" + the roll impact). refId
// is a STABLE entity id (a destinationId / IdP connId / source binding name), never a secret value.
export interface UsageLink {
  kind: "destination" | "idpConnection" | "sourceBinding";
  refId: string;
}

// ExpiryItem mirrors the engine byte-for-byte: redaction-safe metadata ONLY (no secret, no fingerprint).
// expiresAt is OPTIONAL, a no-expiry credential omits it. tokenRef is a PUBLIC Cloudflare token id
// descriptor (never the value), set only on an ephemeral cleanup row.
export interface ExpiryItem {
  id: string;
  label: string;
  kind: ExpiryKind;
  expiresAt?: string;
  source: "manual" | "observed";
  note?: string;
  lifecycleClass?: ExpiryLifecycleClass;
  purpose?: string;
  permissionSummary?: string;
  usageLink?: UsageLink;
  tokenRef?: string;
  observedAt?: string;
  usedAt?: string;
  cleanupState?: "pending" | "attested-deleted";
}

// ExpiryItemInput is the POST /admin/expiry body. Only the operator-settable fields are accepted; the
// engine manages the observed fields (usageLink / tokenRef / observedAt / cleanupState / usedAt). noExpiry
// is a control flag (NOT stored): it signals the operator's deliberate no-expiry choice (omit expiresAt).
export interface ExpiryItemInput {
  id?: string;
  label: string;
  kind: ExpiryKind;
  expiresAt?: string;
  noExpiry?: boolean;
  source?: "manual" | "observed";
  note?: string;
  lifecycleClass?: ExpiryLifecycleClass;
  purpose?: string;
}

// ExpiryStatus is the computed GET /admin/expiry row: the item plus daysRemaining and a state. A
// no-expiry item omits expiresAt/daysRemaining and reads state "no-expiry" (never "ok"/green). source is
// promoted so the UI can badge an auto-observed item; tokenRef appears only on an ephemeral cleanup row.
// thresholds: approaching when daysRemaining <= 30; the engine emits credential-expiry notifications at
// the (tiered) 60 / 30 / 14 / 7 / 1 transitions (60 first for certificate + licence). expired when past.
export interface ExpiryStatus {
  id: string;
  label: string;
  kind: ExpiryKind;
  expiresAt?: string;
  daysRemaining?: number;
  state: "ok" | "approaching" | "expired" | "no-expiry";
  source: "manual" | "observed";
  lifecycleClass?: ExpiryLifecycleClass;
  purpose?: string;
  permissionSummary?: string;
  usageLink?: UsageLink;
  observedAt?: string;
  usedAt?: string;
  cleanupState?: "pending" | "attested-deleted";
  tokenRef?: string;
}
