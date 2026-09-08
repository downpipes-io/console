// The integration CATALOGUE: the 39 named SIEM / observability / ITSM / notification destinations the engine can
// forward the audit trail and metrics to, presented as one logo-tile grid (the SIEM/monitoring sibling of the
// IdP provider grid). Each entry names the vendor, the mark it renders (marks.ts), the category it groups
// under, and the SETUP KIND that decides which config surface its panel wires to. The vendor list is matched
// to the engine's real push formats, OTLP push, /metrics pull, and notify channel kinds, and mirrors the
// website's verified /integrations catalogue (website/src/pages/integrations.astro).
//
// AUTO-PARSE is an honest claim: `auto` is set only where the destination's own tool reads our format natively
// with no field mapping; for monitoring it is the four incident tools with dedup/auto-resolve and the
// Datadog OTLP metrics push.
//
// House rules: Australian English, no em dashes, precise claims.

import type { PushFormat, PushSink, ChannelKind } from "../../api.ts";

// How a destination connects, which decides the panel its tile opens:
//   push          a SIEM audit-log push (a wire format over http / syslog-tls / s3) -> the push config
//   pull          the destination reads OUR audit feed on its own schedule -> a pull credential to copy
//   metrics       the destination scrapes OUR /metrics endpoint -> the metrics scrape credential to copy
//   metrics-push  an OTLP metrics push we send -> the OTLP config
//   notify        an alert channel (incident / chat / webhook / email) -> a notify channel of `channelKind`
export type SetupKind = "push" | "pull" | "metrics" | "metrics-push" | "notify";

export type Category = "SIEM" | "Metrics and observability" | "Incident and on-call" | "Chat and generic";

export interface Vendor {
  // The exact display name (also the accessible label for the decorative mark).
  name: string;
  // The marks.ts key: a real brand mark, a niche-vendor monogram key, or null (initials from the name).
  mark: string | null;
  category: Category;
  kind: SetupKind;
  // Set only where the destination genuinely auto-parses a first-time feed with no field mapping.
  auto?: boolean;
  // One honest line naming the method, shown in the tile's setup panel (never a marketing claim).
  method: string;
  // push only: the wire format and sink pre-selected for this vendor (the auto-parse-first default).
  pushFormat?: PushFormat;
  pushSink?: PushSink;
  // push only: the label for the credential field (an HEC token, an API key, a bearer token...).
  credLabel?: string;
  // push only: the literal Authorization SCHEME this vendor's credential must carry, INCLUDING its trailing
  // space ("Splunk " for a Splunk HEC token). Set only where the vendor genuinely requires one, and read by
  // BOTH the form's note and the secret field's validator, so the instruction and the enforcement cannot
  // disagree the way they did before this field existed.
  //
  // WHY IT LIVES ON THE VENDOR AND NOT ON THE FORMAT. The old rule keyed the Splunk note off
  // `pushFormat === "splunk-hec"`. CrowdStrike Falcon Next-Gen SIEM takes that same format over the same http
  // sink and issues a plain BEARER token, so the Splunk instruction rendered on the Falcon form and told the
  // operator to prefix a Falcon token with the word Splunk. Keyed off the vendor, Falcon gets no scheme rule
  // and Splunk gets an enforced one.
  credScheme?: string;
  // push only: a worked example of a correctly-formed credential, for the validator's remedy sentence. Never a
  // real token: an obviously-synthetic value in the vendor's own shape.
  credExample?: string;
  // notify only: the engine channel kind this tile creates/manages (Opsgenie shares "jsm" with JSM).
  channelKind?: ChannelKind;
  // The one deliberate escape hatch: a push tile with NO fixed format/sink, so its panel is the full generic
  // form (you choose the wire + delivery). For a SIEM or endpoint not in the named catalogue.
  custom?: boolean;
  // The docs-site slug OVERRIDE, set only where the name-derived slug (vendorSlug()) does not name the
  // docs page this tile actually needs. Two distinct causes, both fixed the same way:
  //   - the docs page's real filename is not the full display name's slug (CrowdStrike Falcon Next-Gen
  //     SIEM's page is /integrations/crowdstrike, not the whole name; Grafana OnCall's is
  //     /integrations/grafana-oncall-irm);
  //   - two catalogue entries share a display name across categories (the Datadog SIEM push tile and the
  //     Datadog OTLP metrics-push tile both read "Datadog", so vendorSlug() collapses them to one slug and
  //     the metrics tile's "view docs" link opened the SIEM push guide -- the metrics tile sets
  //     docSlug: "datadog-metrics" to point at its own page).
  // NEVER used for the stored destination-identity tag: that is vendorSlug() alone (PushDestinationInput.
  // vendor), unaffected by this field, so overriding a docs link can never relabel a live push.
  docSlug?: string;
}

// The catalogue, grouped by category. Order within a group is popularity-ish for the named vendors, matching
// the website; it is not load-bearing (the tile state and the auto tag carry the signal).
export const CATALOGUE: Vendor[] = [
  // ---- SIEM (audit-log push, 21) ----
  { name: "Splunk", mark: "splunk", category: "SIEM", kind: "push", auto: true, pushFormat: "splunk-hec", pushSink: "http", credLabel: "HEC token", credScheme: "Splunk ", credExample: "Splunk 12345678-abcd-1234-abcd-1234567890ab", method: "HTTP Event Collector push with one token. The HEC auto-extracts fields on arrival." },
  { name: "Microsoft Sentinel", mark: "microsoft", category: "SIEM", kind: "pull", method: "Codeless connector: run the ARM template once and it polls us into a typed table." },
  { name: "QRadar", mark: "ibm", category: "SIEM", kind: "push", pushFormat: "cef", pushSink: "syslog-tls", method: "CEF over syslog-TLS into a Universal CEF/LEEF log source, parsed by the built-in DSM." },
  { name: "Elastic", mark: "elastic", category: "SIEM", kind: "push", pushFormat: "json-array", pushSink: "http", credLabel: "API key", method: "JSON array push that splits into individual events for your ingest pipeline." },
  { name: "Datadog", mark: "datadog", category: "SIEM", kind: "push", auto: true, pushFormat: "datadog", pushSink: "http", credLabel: "API key", method: "Logs intake push with one API key. Datadog auto-facets the JSON on arrival." },
  { name: "CrowdStrike Falcon Next-Gen SIEM", mark: "crowdstrike", category: "SIEM", kind: "push", pushFormat: "splunk-hec", pushSink: "http", credLabel: "bearer token", method: "HTTP Event Collector push to your Falcon endpoint, with a bearer token.", docSlug: "crowdstrike" },
  { name: "ArcSight", mark: "arcsight", category: "SIEM", kind: "push", pushFormat: "cef", pushSink: "syslog-tls", method: "CEF over syslog-TLS into your SmartConnector, the format ArcSight originated." },
  { name: "Sumo Logic", mark: "sumologic", category: "SIEM", kind: "push", pushFormat: "ndjson", pushSink: "http", credLabel: "HTTP Source token", method: "NDJSON push to a Sumo Logic HTTP Source, which reads the fields on arrival." },
  { name: "Graylog", mark: "graylog", category: "SIEM", kind: "push", pushFormat: "gelf", pushSink: "http", method: "GELF push straight to your Graylog HTTP input." },
  { name: "Google Security Operations", mark: "google", category: "SIEM", kind: "push", pushFormat: "ndjson", pushSink: "http", method: "NDJSON push. Pick a matching log type once, and it parses from there." },
  { name: "FortiSIEM", mark: "fortinet", category: "SIEM", kind: "push", pushFormat: "cef", pushSink: "syslog-tls", method: "CEF over syslog-TLS into FortiSIEM." },
  { name: "Cortex", mark: "paloalto", category: "SIEM", kind: "push", pushFormat: "ndjson", pushSink: "http", method: "NDJSON push to its HTTP collector (Cortex is the receiver, not a poller)." },
  { name: "LogRhythm", mark: "logrhythm", category: "SIEM", kind: "push", pushFormat: "cef", pushSink: "syslog-tls", method: "CEF over syslog-TLS into a LogRhythm Log Source Type you define." },
  { name: "Securonix", mark: "securonix", category: "SIEM", kind: "push", pushFormat: "cef", pushSink: "syslog-tls", method: "CEF over syslog-TLS through your Securonix connector." },
  { name: "Rapid7 InsightIDR", mark: "rapid7", category: "SIEM", kind: "push", pushFormat: "json-array", pushSink: "http", method: "JSON array push over HTTPS into your InsightIDR log source." },
  { name: "Exabeam", mark: "exabeam", category: "SIEM", kind: "pull", method: "Exabeam pulls the audit feed with a bearer token, cursored by sequence number." },
  { name: "Panther", mark: "panther", category: "SIEM", kind: "push", pushFormat: "json-array", pushSink: "http", method: "JSON array push. Infer the schema in Panther once, then it parses on arrival." },
  { name: "Devo", mark: "devo", category: "SIEM", kind: "push", pushFormat: "ndjson", pushSink: "http", credLabel: "token (in the URL path)", method: "NDJSON push to your Devo HTTP endpoint, token in the URL path, Devo's own convention." },
  { name: "Logpoint", mark: "logpoint", category: "SIEM", kind: "push", pushFormat: "ndjson", pushSink: "http", method: "NDJSON push over HTTPS into your Logpoint ingest." },
  { name: "Cribl", mark: "cribl", category: "SIEM", kind: "pull", method: "Cribl pulls the audit feed with a bearer token and routes it downstream." },
  { name: "Wazuh", mark: "wazuh", category: "SIEM", kind: "push", pushFormat: "ndjson", pushSink: "s3", credLabel: "S3 access key and secret", method: "NDJSON batches dropped to an S3 bucket your Wazuh already reads. No bespoke API." },
  // LOAD-BEARING, and not obvious from this line: this is the ONLY route in the console that renders the
  // Delivery and Format selects. Every other kind:"push" entry carries both pushFormat and pushSink, which
  // panels.ts turns into a `lock`, and settings/push.ts HIDES both selects whenever a lock is present. This
  // entry has neither field, so no lock is built and the two pickers appear. Verified mechanically: it is the
  // only kind:"push" entry in this array missing either field, and renderPushDestination has exactly one call
  // site. Three docs pages describe picking a Delivery and a Format and depend on this tile being reachable,
  // so giving it a pushFormat/pushSink pair, or gating the tile, would silently remove the only place a
  // customer can choose either, and take those pages with it.
  { name: "Custom endpoint", mark: "custom", category: "SIEM", kind: "push", custom: true, method: "A SIEM or HTTPS endpoint not in the list. You choose the wire format and delivery it expects." },

  // ---- Metrics and observability (7) ----
  { name: "Prometheus", mark: "prometheus", category: "Metrics and observability", kind: "metrics", method: "Point your Prometheus at our /metrics endpoint. Native fields, nothing to map." },
  { name: "Grafana", mark: "grafana", category: "Metrics and observability", kind: "metrics", method: "Point Grafana Alloy at our /metrics endpoint, or scrape it agentless from Grafana Cloud." },
  { name: "Datadog", mark: "datadog", category: "Metrics and observability", kind: "metrics-push", auto: true, credLabel: "API key", method: "OTLP-JSON metrics push, auto-faceted on arrival. One setting, your endpoint and key.", docSlug: "datadog-metrics" },
  { name: "New Relic", mark: "newrelic", category: "Metrics and observability", kind: "metrics", method: "New Relic reads our /metrics endpoint through its Prometheus integration." },
  { name: "Dynatrace", mark: "dynatrace", category: "Metrics and observability", kind: "metrics", method: "Dynatrace reads our /metrics endpoint via its OpenTelemetry Collector or ActiveGate." },
  { name: "Elastic Observability", mark: "elastic", category: "Metrics and observability", kind: "metrics", method: "Point Elastic Agent at our Prometheus-compatible /metrics endpoint; no mapping to build." },
  { name: "Splunk Observability", mark: "splunk", category: "Metrics and observability", kind: "metrics", method: "Point the Splunk OpenTelemetry Collector at our /metrics endpoint." },

  // ---- Incident and on-call (7) ----
  { name: "PagerDuty", mark: "pagerduty", category: "Incident and on-call", kind: "notify", channelKind: "pagerduty", auto: true, credLabel: "Routing key", method: "Push with dedup and auto-resolve. One setting, your routing key." },
  { name: "Opsgenie", mark: "opsgenie", category: "Incident and on-call", kind: "notify", channelKind: "jsm", auto: true, credLabel: "API integration key", method: "Push with alias-based dedup and auto-resolve, on the JSM Alert API. One setting, your API key." },
  { name: "ServiceNow", mark: "servicenow", category: "Incident and on-call", kind: "notify", channelKind: "servicenow", auto: true, credLabel: "Event Management key", method: "Event Management push with auto-clear; closing a linked incident follows your ITOM rules." },
  { name: "Jira Service Management", mark: "jira", category: "Incident and on-call", kind: "notify", channelKind: "jsm", auto: true, credLabel: "API key", method: "Push with alias-based dedup and auto-resolve. One setting, your API key." },
  { name: "incident.io", mark: "incidentio", category: "Incident and on-call", kind: "notify", channelKind: "webhook", method: "A webhook with a ready-made mapping recipe." },
  { name: "Grafana OnCall", mark: "grafana", category: "Incident and on-call", kind: "notify", channelKind: "webhook", method: "A webhook with a ready-made mapping recipe.", docSlug: "grafana-oncall-irm" },
  { name: "Splunk On-Call", mark: "splunk", category: "Incident and on-call", kind: "notify", channelKind: "webhook", method: "A webhook with a ready-made mapping recipe." },

  // ---- Chat and generic (4) ----
  { name: "Slack", mark: "slack", category: "Chat and generic", kind: "notify", channelKind: "slack", method: "Real-time alerts to your Slack channel. Pair with an incident tool for dedup and auto-resolve." },
  { name: "Microsoft Teams", mark: "microsoft", category: "Chat and generic", kind: "notify", channelKind: "teams", method: "Real-time alerts to your Teams channel, via a connector or email." },
  { name: "Email", mark: "mail", category: "Chat and generic", kind: "notify", channelKind: "email", method: "Alerts to any address you choose." },
  { name: "Webhook", mark: "webhook", category: "Chat and generic", kind: "notify", channelKind: "webhook", method: "Any HTTPS endpoint you run, in a documented JSON shape." },
];

// The category order the screen groups by (SIEM first, then observability, incident, chat).
export const CATEGORY_ORDER: Category[] = ["SIEM", "Metrics and observability", "Incident and on-call", "Chat and generic"];

// vendorsByCategory groups the catalogue for the grid's sectioned render, preserving list order.
export function vendorsByCategory(): Array<{ category: Category; vendors: Vendor[] }> {
  return CATEGORY_ORDER.map((category) => ({ category, vendors: CATALOGUE.filter((v) => v.category === category) }));
}

// vendorSlug is the vendor's stable machine identity: the display name lowercased with every run of
// non-alphanumerics collapsed to a single hyphen. It backs two things, deliberately the same string for both:
// the docs-site page path (docsUrl below), and the OPAQUE destination-identity tag the push config stores so
// the engine can say WHICH vendor a live push belongs to (PushDestinationInput.vendor).
//
// WHY A SLUG OF THE NAME RATHER THAN A SEPARATE ID FIELD. The catalogue is the only place a vendor NAME lives,
// so the name already is the identity; a second hand-maintained id column would be one more thing to keep in
// step. The consequence to know: RENAMING a vendor changes its slug, so a push stored under the old slug stops
// being claimed by that tile and reads as "not set up" with the active-elsewhere warning beside it. That is
// recoverable (Set up again, one form) and visible, not silent data loss. validate-integrations.ts pins the
// slugs as unique so two vendors can never collide on one.
export function vendorSlug(v: Vendor): string {
  return v.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// docsUrl is the vendor's own setup guide on the docs site (docs.downpipes.io/integrations/<slug>). Every
// catalogue name maps to its page through vendorSlug, UNLESS the entry sets docSlug (see Vendor.docSlug):
// the docs page's real filename does not always match the name-derived slug, and two entries can share a
// display name across categories (Datadog push vs Datadog metrics-push) while needing different pages. The
// panels link to it for the vendor-specific setup detail, notably the exact Cloudflare Access remedy,
// rather than half-explaining it.
export function docsUrl(v: Vendor): string {
  return `https://docs.downpipes.io/integrations/${v.docSlug ?? vendorSlug(v)}`;
}
