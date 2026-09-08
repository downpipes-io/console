// Outbound audit-log push (SIEM) mirror types, split out of ../types.ts (move-only, same pattern as every
// other types/<domain>.ts). See ../types.ts for the barrel. Mirrors the engine's push-destination admin
// surface:
// the engine dials OUT to a customer SIEM on the scheduler tick, so a Cloudflare Access perimeter fronting
// the console cannot block it (unlike the audit-feed PULL credential, ./support.ts). Every secret (the http
// auth header value, and the S3-drop sink's secret access key) is sealed at rest and NEVER returned: every
// read type here carries the endpoint / format / header NAME / redacted S3 location only.

// PushFormat is the closed set of envelope shapers the engine supports. ndjson
// is one raw audit event object per line (the split-friendly DEFAULT for a new destination); json-array is a
// bare [event, ...] array (array-splitting intakes like Elastic and Panther); raw-json POSTs the pull feed's
// own {kind,events[]} wrapper (kept selectable, no longer the default); splunk-hec shapes one HEC event per
// audit event; datadog shapes a JSON array of Datadog log objects; cef and leef are one ArcSight-CEF /
// IBM-LEEF line per event (delivered over the syslog-tls sink for auto-parse, and secondarily over http);
// gelf is one Graylog GELF object per line. Mirrors the engine's PushFormat (scheduler-do-limits.ts) one for
// one; the two allow-lists move in lockstep.
export type PushFormat = "raw-json" | "ndjson" | "json-array" | "splunk-hec" | "datadog" | "cef" | "leef" | "gelf";

// PushSink is the closed delivery-mechanism selector. "http" (the default) dials
// the endpoint out through the engine's egress-secure sender with the one configured auth header (or the
// url-token option); "s3" drops one NDJSON object per drain batch into an S3-compatible bucket the SIEM
// already reads (reusing the archive S3 PUT client, so no bespoke SigV4); "syslog-tls" delivers CEF/LEEF
// lines as RFC 5424 records over a Cloudflare TCP socket (the enterprise auto-parse path for QRadar and
// LogRhythm). Mirrors the engine's PushSink; the two allow-lists move in lockstep.
export type PushSink = "http" | "s3" | "syslog-tls";

// PushDeliveryAttempt is one entry in the bounded delivery trail (capped 50, most recent LAST). ok is the
// coarse at-least-once outcome; httpStatus is the SIEM's real HTTP status when a request completed; reason
// is a coarse DeliveryFailCode-style string on failure, NEVER a response body; count/fromSeq/toSeq describe
// the delivered batch (a test send carries no seq range: it does not advance the cursor).
export interface PushDeliveryAttempt {
  at: string; // ISO
  ok: boolean;
  httpStatus?: number;
  reason?: string;
  count?: number;
  fromSeq?: number;
  toSeq?: number;
}

// PushS3View is the REDACTED S3-drop location the view carries: the endpoint / bucket / region / optional key
// prefix ONLY. It NEVER carries the access key id or the sealed secret access key (both are write-only, like
// an archive destination's credential). Mirrors the engine view's `s3` shape exactly.
export interface PushS3View {
  endpoint: string;
  bucket: string;
  region: string;
  prefix?: string;
}

// PushSyslogTarget is the syslog-tls sink's target: host + port (default 6514, RFC 5425 syslog-over-TLS). No
// secret (syslog auth is network/mTLS, out of scope: the feed is the customer's own SIEM). Used on both the
// view (redaction-safe, no secret exists) and the input.
export interface PushSyslogTarget {
  host: string;
  port: number;
}

// PushDestinationView is GET /admin/push. present:false means no destination is configured, and every other
// field but trail is then absent. NEVER carries any secret or its ciphertext, by construction: this type has
// no secret-shaped field at all (the S3 view is the redacted location only, never the access key). headSeq/
// lastPushedSeq let the console compute the cursor lag (headSeq - lastPushedSeq); trail is the bounded
// delivery history, oldest first, most recent last. The http-specific fields (endpoint/authHeaderName/
// authInUrl) ride ONLY for the http sink; s3/syslog carry their own redaction-safe location instead.
export interface PushDestinationView {
  present: boolean;
  endpoint?: string; // http sink only
  format?: PushFormat;
  authHeaderName?: string; // http sink only
  enabled?: boolean;
  // sink echoes the delivery mechanism (absent reads "http" on a legacy record). authInUrl echoes whether the
  // http sink carries the auth token in the URL (a boolean posture, NEVER the token). s3 echoes the redacted
  // S3-drop location; syslog echoes the host/port. All redaction-safe.
  sink?: PushSink;
  // vendor is the engine's echo of the OPAQUE destination-identity tag the console wrote when the operator set
  // this destination up from a vendor tile (a catalogue slug, screened by the engine as a bounded lowercase
  // slug, never operator free text and never a secret). It answers the one question format-crossed-with-sink
  // cannot: Splunk and CrowdStrike Falcon Next-Gen SIEM both take splunk-hec over http, so without this a
  // single live push lit both tiles Active. ABSENT on a destination stored before the tag existed, which reads
  // as "the config does not record a vendor", never as any particular vendor.
  vendor?: string;
  authInUrl?: boolean; // http sink only
  s3?: PushS3View; // s3 sink only
  syslog?: PushSyslogTarget; // syslog-tls sink only
  setBy?: string | null;
  setAt?: string | null; // ISO
  lastPushedSeq?: number;
  headSeq?: number;
  trail: PushDeliveryAttempt[];
}

// PushS3TargetInput is the S3-drop sink's target on the POST /admin/push body: the endpoint / bucket / region
// and the credential pair (accessKeyId + the WRITE-ONLY secretAccessKey), plus the optional key prefix. It
// mirrors the archive destination credential idiom: the secret rides ONLY when the operator typed one (a
// fresh configure or a rotate); an omitted secretAccessKey means "keep the currently sealed s3 secret". The
// engine wraps the secret under a DISTINCT AAD (PUSH_S3_SECRET_AAD) so a push-header secret and an archive
// credential can never be cross-opened as this key.
//
// CONTRACT NOTE: the engine's buildPushS3Target REQUIRES a
// non-empty accessKeyId on EVERY set (including a bare enable/disable toggle), but the redacted view carries
// NO accessKeyId (it is not a secret, yet it is not echoed). The console therefore cannot reconstruct a valid
// s3Target from the view alone, so the lightweight enable/disable toggle is offered for the http and
// syslog-tls sinks only; for the s3 sink, enabling/disabling is done through Replace (which re-collects the
// access key). Exposing accessKeyId on the view (redaction-safe, like a username) would let the s3 toggle
// work uniformly.
export interface PushS3TargetInput {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey?: string; // write-only; omitted means keep the sealed secret unchanged
  addressing?: string; // "auto" | "path" | "vhost"; non-secret
  storageClass?: string; // an S3 storage class; non-secret
  prefix?: string; // key prefix for the per-batch object; default set by the engine
}

// PushDestinationInput is the console-side type name for the POST /admin/push body. Mirrors the engine's
// accepted shape (router-push.ts validatePushSetShape): format + enabled always; the sink (default "http")
// selects which target fields ride. For http: endpoint / authHeaderName / authInUrl / the write-only
// authHeaderValue. For s3: the s3Target. For syslog-tls: syslog. The engine wraps each secret at the router
// (each under its OWN AAD) before it ever reaches the DO, and never returns it.
//
// KEEP-SECRET: both secrets (authHeaderValue and
// s3Target.secretAccessKey) are OPTIONAL. An omitted secret means "keep the currently sealed secret
// unchanged", so the console can toggle `enabled` or edit a non-secret field without resupplying a write-only
// secret it never retained. A FIRST-ever create still requires the sink's secret (the engine's buildPushRecord
// rejects a first set with no secret). The two secrets have INDEPENDENT lifecycles: rotating one never
// disturbs the other. See src/screens/settings/push.ts for the call sites.
export interface PushDestinationInput {
  format: PushFormat;
  enabled: boolean;
  sink?: PushSink; // default "http"
  endpoint?: string; // http sink
  authHeaderName?: string; // http sink
  authInUrl?: boolean; // http sink: splice the token into the URL, send no auth header
  authHeaderValue?: string; // http sink write-only secret; omitted means keep the sealed secret
  s3Target?: PushS3TargetInput; // s3 sink
  syslog?: PushSyslogTarget; // syslog-tls sink
  // vendor is the OPAQUE destination-identity tag (a catalogue slug, vendorSlug()). It rides when the form was
  // opened from a vendor tile, which is every Integrations panel, and is omitted by any caller that cannot say
  // which vendor it is. The engine stores it, echoes it in the view and never interprets it. It must survive a
  // keep-secret re-set: dropping it on an enable/disable toggle would hand tile identity back to the wire.
  vendor?: string;
}

// PushTestResult is POST /admin/push/test: sends ONE synthetic audit-shaped event through the same
// egress-secure sender the drain uses (per sink) and reports the honest outcome (a real SIEM HTTP status, a
// timeout, a blocked-by-egress-guard reason). Never advances the cursor.
export interface PushTestResult {
  ok: boolean;
  httpStatus?: number;
  reason?: string;
  ms?: number;
}
