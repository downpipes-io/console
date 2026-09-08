// Outbound OTLP/HTTP metrics push mirror types, split out the same way every other types/<domain>.ts
// is (see ./push.ts for the SIEM audit-log push sibling this mirrors). The engine pushes the
// canonical backup-health metric snapshot (downpipe_backup_last_success_timestamp_seconds, _success,
// _recent_attempts/successes/failures, _duration_seconds, _size_bytes, destination_healthy) to a
// customer OTLP/HTTP collector on the cron tick, zero-agent. OTLP-JSON is confirmed for Datadog only; Dynatrace, Elastic and Splunk
// Observability accept OTLP as protobuf only and reject JSON (they read the metrics scrape endpoint
// instead). UNLIKE the SIEM push there is no cursor: every enabled tick re-reads the
// CURRENT state and pushes a fresh snapshot, so a missed tick is a gap in the customer's own time
// series, never a backlog. The one secret (the bearer/API-key auth header value) is sealed at rest
// and NEVER returned by a read: the view carries the header NAME only.

// OtlpPushDeliveryAttempt is one entry in the bounded delivery trail (capped 50, most recent LAST,
// mirroring PushDeliveryAttempt). ok is the coarse outcome; httpStatus is the collector's real HTTP
// status when a request completed; reason is a coarse DeliveryFailCode-style string on failure,
// NEVER a response body. downpipeCount is the ACTUAL number of downpipes shaped into this push
// (post-cap, never the pre-cap snapshot length); truncated flags a fleet larger than the engine's
// per-push cap, so an over-cap fleet is a loud trail signal, never a silent partial.
export interface OtlpPushDeliveryAttempt {
  at: string; // ISO
  ok: boolean;
  httpStatus?: number;
  reason?: string;
  downpipeCount?: number;
  truncated?: boolean;
}

// OtlpPushDestinationView is GET /admin/otlp-push. present:false means no destination is configured,
// and every other field but trail is then absent. NEVER carries the secret or its ciphertext, by
// construction: this type has no secret-shaped field at all. Unlike PushDestinationView there is no
// sink/format selector (OTLP push is always one shape, one transport) and no cursor (no fromSeq/
// toSeq/headSeq: every push is a fresh snapshot, not a drained log).
export interface OtlpPushDestinationView {
  present: boolean;
  endpoint?: string;
  authHeaderName?: string;
  enabled?: boolean;
  setBy?: string | null;
  setAt?: string | null; // ISO
  trail: OtlpPushDeliveryAttempt[];
}

// OtlpPushDestinationInput is the console-side type for the POST /admin/otlp-push body: endpoint and
// authHeaderName and enabled always; the WRITE-ONLY authHeaderValue rides only when the operator
// typed one (an omitted value means "keep the currently sealed secret unchanged"; a first-ever
// create still needs one, the engine rejects a bare create with none).
export interface OtlpPushDestinationInput {
  endpoint: string;
  authHeaderName: string;
  authHeaderValue?: string;
  enabled: boolean;
}
