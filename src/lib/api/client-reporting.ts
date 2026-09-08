// Reporting domain functions for the EngineClient (split from client.ts per findings console-src-010-01 /
// console-sys-arch-01 / console-sys-struct-03): signed, tamper-evident reports, the compliance evidence
// packs, and the RTO estimate. Free functions over the shared Transport; request URL/method/body/headers and
// parse/throw logic moved VERBATIM.
//
// A report is generated in-account over the customer's own observable state and SIGNED with the engine
// signer, so an auditor can verify it (tamper-evident, signed; never tamper-proof). Reads are gated by the
// reports.read capability (any authenticated role has it). The JSON variant returns the Report; the PDF
// variant returns the rendered application/pdf bytes for a download. No secret transits: a report carries
// names, counts, timestamps and a signature only.

import { engineFetch } from "./engine-fetch.ts";
import type { Transport } from "./client-transport.ts";
import type { Report, ReportKind, RtoReport } from "./types.ts";

// getReport fetches one report as JSON (GET /admin/reports/:kind). The signature, when present, is
// a hybrid "edmldsa1:..." signature over the canonical {kind,generatedAt,period,data}; the screen
// shows the signature-verified state. reports.read.
export async function getReport(t: Transport, kind: ReportKind): Promise<Report> {
  const r = await engineFetch(`${t.base}/admin/reports/${encodeURIComponent(kind)}`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<Report>(r, "report");
}

// getReportPDF fetches one report rendered as a PDF (GET /admin/reports/:kind?format=pdf),
// returning the raw bytes so the caller triggers a download. Like exportAudit this is not a JSON
// route, so it does not use parseJson; a non-2xx still routes through failResponse so an
// Access-redirect body (C2-1) is named honestly rather than read as a corrupt PDF. The bytes are
// generated in-account (the customer's own data); no custody concern. reports.read.
export async function getReportPDF(t: Transport, kind: ReportKind): Promise<Uint8Array> {
  const r = await engineFetch(`${t.base}/admin/reports/${encodeURIComponent(kind)}?format=pdf`, { headers: t.headers(), credentials: "include" });
  if (!r.ok) return t.failResponse(r, "report pdf");
  return new Uint8Array(await r.arrayBuffer());
}

// getEvidencePackPDF fetches the customer-specific, signed compliance evidence pack for one framework
// (or "all") rendered as a PDF (GET /admin/reports/evidence-pack?framework=<id>&format=pdf). It is the
// evidence-pack variant of getReportPDF: same in-account, no-custody, fail-honest handling, with the
// framework selecting which control mapping the live posture is projected through. reports.read.
export async function getEvidencePackPDF(t: Transport, framework: string): Promise<Uint8Array> {
  const r = await engineFetch(`${t.base}/admin/reports/evidence-pack?framework=${encodeURIComponent(framework)}&format=pdf`, { headers: t.headers(), credentials: "include" });
  if (!r.ok) return t.failResponse(r, "evidence pack pdf");
  return new Uint8Array(await r.arrayBuffer());
}

// getEvidencePack fetches the same pack as JSON (GET /admin/reports/evidence-pack?framework=<id>), so a
// reviewer can inspect the signed {kind,generatedAt,period,data} exactly as the engine emitted it.
export async function getEvidencePack(t: Transport, framework: string): Promise<Report> {
  const r = await engineFetch(`${t.base}/admin/reports/evidence-pack?framework=${encodeURIComponent(framework)}`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<Report>(r, "evidence pack");
}

// rto fetches the RTO (recovery-time) estimate (GET /admin/rto[?id=<downpipeId>]), the recovery-time
// companion to the RPO/freshness signal (engine src/admin/router.ts GET /rto -> the DO rtoData handler
// in src/sched/scheduler-do.ts; the shape is engine src/admin/rto.ts RtoEstimate). It returns the fleet
// roll-up plus a per-downpipe estimate (only the ?id= downpipe when an id is given, still with the fleet
// roll-up so a console can show "this pipe vs the fleet"). Each estimate is an HONEST projection derived
// from observed restore-test throughput: known:false means there is no drill history and there is NO
// fabricated number, only a reason; known:true carries the derived estimateSeconds, a "based on N drills"
// basedOnDrills count and a coarse confidence. Gated by reports.read (any authenticated role). No-custody:
// every field is a count, a duration, a coarse confidence or a redaction-safe reason; never a value or key.
export async function rto(t: Transport, id?: string): Promise<RtoReport> {
  const suffix = id ? `?id=${encodeURIComponent(id)}` : "";
  const r = await engineFetch(`${t.base}/admin/rto${suffix}`, { headers: t.headers(), credentials: "include" });
  return t.parseJson<RtoReport>(r, "rto");
}
