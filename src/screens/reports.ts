// Reports (build contract section 6 + section 9 console surfaces): the signed, tamper-evident
// reports (restore tests, SLA compliance, immutability and posture) and the compliance evidence pack,
// each viewable as JSON, downloadable as a PDF, and showing its signature-verified
// state. A report is generated in the customer's own account over their own observable
// state and SIGNED with the engine signer, so an auditor can verify it. The vendor reads
// nothing.
//
// House rules carried through:
//   - Precise claims: a signed report is "tamper-evident, signed", NEVER "tamper-proof".
//     The signature scheme is the post-quantum hybrid "edmldsa1:" (Ed25519 + ML-DSA-87).
//     The console shows the signature is PRESENT and well-formed and offers it for an
//     auditor to verify out of band; it does not claim to have cryptographically verified
//     it client-side (the verifying public key is not shipped to the browser), so the copy
//     never overstates. An UNSIGNED report says so plainly rather than implying assurance.
//   - No-custody / redaction-by-construction: a report carries names, counts, timestamps
//     and a signature only, never a secret. The JSON view and the PDF are the customer's
//     own data; no custody concern. Every server-supplied string enters the DOM via
//     textContent / typed element creation (dom.ts), so the JSON view cannot inject markup.
//   - Capability gating: reads are gated by reports.read (any authenticated role), so
//     there is no write affordance here to gate; the engine is the enforcement point.
//   - Two-channel error model: a thrown 401 routes to signed-out; a transport/5xx on a
//     fetch is a block error with Retry (never a stale green); a download/view failure is
//     surfaced inline or as a warn toast; a confirmational success (download started) is a
//     toast. The PDF route returns bytes, so a non-2xx is named honestly by the api layer.
//   - The six states per report card: idle (not yet fetched), loading (busy), error (an
//     inline retry), success (the metadata + signature state + the View/Download actions).
//
// CSP / CSSOM: styles via h() + node.style.setProperty (the dom.ts builder), never
// setAttribute("style").

import { h, svgIcon } from "../lib/dom.ts";
import {
  pageHeader,
  requireEngine,
  defineScreen,
  type Screen,
  type ScreenContext,
} from "./common.ts";
import { goSignedOut } from "../lib/nav.ts";
import { isUnauthorised, errText } from "../lib/errors.ts";
import { blockError, sessionEnded } from "../components/error-view.ts";
import { skeletonRows, noteQuiet } from "../components/feedback.ts";
import { openModal } from "../components/modal.ts";
import { toast } from "../components/toast.ts";
import { codeBlock, copyButton } from "../components/code-block.ts";
import { statusWithLabel } from "../components/status.ts";
import { relativeTime, absoluteTime } from "../lib/format.ts";
import {
  ICON_AUDIT,
  ICON_LOCK,
  ICON_LICENCE,
  ICON_REFRESH,
  ICON_REPORT,
  ICON_SHIELD_CHECK,
} from "../lib/icons.ts";
import type {
  EngineClient,
  Report,
  ReportKind,
} from "../api.ts";
import { evidencePacksSection } from "./reports-evidence-packs.ts";
import { rtoPanel } from "./reports-rto.ts";
import {
  signatureState,
  periodPhrase,
  signatureBadge,
  safeStringify,
  truncateMiddle,
  downloadBytes,
} from "./reports-helpers.ts";

// Re-export the pure helpers and value types so existing importers and the validator
// (test/validate-reports.ts imports these from this module) are unchanged after the
// move into sibling modules.
export {
  signatureState,
  periodPhrase,
  humanSeconds,
  rtoEstimateLine,
  type SignatureState,
  type RtoLine,
} from "./reports-helpers.ts";

// ---------------------------------------------------------------------------
// The screen descriptor. measure:"wide" because the report cards
// read as a dense list of generated artefacts. The go-to navigation lives in
// shell/registry.ts + shell/nav.ts; this descriptor contributes the read-class action
// (any authenticated role can read reports, so the action carries no gate beyond a
// connected engine).
// ---------------------------------------------------------------------------

// Exported so an outside caller (the guided tour's chapter vocabulary; chapters.ts) references the
// same literal this descriptor uses, rather than a copy that could drift from it unnoticed (as the tour
// route had, with no pin at all, before COV.7).
export const ROUTE_REPORTS = "/reports";

// The four reports, with the human label, the one-line description of what each attests,
// and the leading glyph. The order is the contract's order (restore-tests first as the
// recoverability evidence, then SLA, immutability, posture). A closed list so a typo
// cannot reach the engine.
interface ReportMeta {
  kind: ReportKind;
  label: string;
  blurb: string;
  icon: string;
  // Optional inert hook the public tour pins a "?" info-point to (the Change records card explains change
  // management). No effect on the genuine console; absent on every card the tour does not annotate.
  tourId?: string;
}

export const REPORTS: ReportMeta[] = [
  {
    kind: "restore-tests",
    label: "Restore tests",
    blurb: "The drill-evidence over the period (each scheduled or manual restore test, pass or fail, with its timestamp), plus the last-test recency per downpipe.",
    // A drill glyph, distinct from the posture report's shield, so the two assurance
    // artefacts read apart at a glance in the card list.
    icon: ICON_REFRESH,
  },
  {
    kind: "sla-compliance",
    label: "SLA compliance",
    blurb: "Per downpipe, the expected versus successful run counts, the freshness, and a strikes count, so a missed schedule is evidenced rather than assumed.",
    icon: ICON_AUDIT,
  },
  {
    kind: "immutability",
    label: "Immutability",
    blurb: "Which destinations are configured and the break-glass versus operational posture: an attestation of the recoverability properties, not a WORM claim the destination cannot back.",
    icon: ICON_LOCK,
  },
  {
    kind: "posture",
    label: "Security posture",
    blurb: "The posture report as a signed artefact: the score and the severity-ranked control checks at the time of generation, for an auditor or a board pack.",
    icon: ICON_SHIELD_CHECK,
  },
];

// CHANGE_REQUESTS_REPORT is the change-management CR ledger: the change-controlled actions over the period
// with the operator's change number and who made each, and any Emergency Changes flagged for retrospective
// review. It is OWNER-OPT-IN, so the card is shown only when Require Change Number is on (appended after a
// policy read in render), not to a tenant that never enabled it.
const CHANGE_REQUESTS_REPORT: ReportMeta = {
  kind: "change-requests",
  // "Change records" (not "requests"): downpipes RECORDS the change number for reconciliation; the request and
  // approval live in the operator's ITSM. (The engine report kind stays "change-requests" as a stable id.)
  label: "Change records",
  blurb: "Every change-controlled action over the period (a destination repoint or removal, an identity-provider change, a restore apply and the other owner actions), with its change number, who made it, and whether it was an Emergency Change to validate retrospectively.",
  icon: ICON_REPORT,
  tourId: "change-record",
};

export const reportsScreen: Screen = defineScreen({
  route: ROUTE_REPORTS,
  title: "Reports",
  measure: "wide",
  actions: [
    // Open the reports surface: a read available to every authenticated role
    // (reports.read), surfaced as a navigation so it is discoverable by verb. No gate
    // beyond a connected engine.
    {
      id: "reports.open",
      title: "Open reports",
      group: "Actions",
      kind: "navigate",
      keywords: ["report", "reports", "audit", "evidence", "sla", "immutability", "posture", "restore tests", "pdf", "signed", "tamper-evident"],
      target: ROUTE_REPORTS,
      when: ({ engine }) => engine.connected !== false,
    },
  ],
  render(_ctx: ScreenContext): HTMLElement {
    const engine = requireEngine();
    const root = h("div");
    if (!engine) return root;

    root.appendChild(
      pageHeader(
        "Reports",
        "Reports generated in your own account over your own observable state; no report data leaves it. A report carries names, counts and timestamps only, never a secret.",
      ),
    );

    // The standing precise-claims line, stated ONCE for the screen (CALM-04: a quiet
    // note, not a tinted card): tamper-evident, never tamper-proof, and where the
    // signature scheme and the out-of-band verification are named.
    const claims = noteQuiet(h("p", "A signed report is tamper-evident, never tamper-proof. The signature is the post-quantum hybrid scheme (Ed25519 with ML-DSA-87) over the canonical report body; verify it out of band against the engine signer."));
    claims.style.setProperty("margin-top", "var(--space-5)");
    root.appendChild(claims);

    const list = h("div", { class: "stack", style: "display:grid;gap:var(--space-4);margin-top:var(--space-5)" });
    for (const meta of REPORTS) list.appendChild(reportCard(engine, meta));
    root.appendChild(list);

    // The change-requests (change management) report is OWNER-OPT-IN: offer its card only when Require Change
    // Number is on, so a tenant that never enabled it is not shown an always-empty report. Appended after the
    // policy read; a read fault simply omits it (the engine still serves the report by direct URL if needed).
    void engine
      .getConfigApprovalPolicy()
      .then((p) => { if (p.requireChangeNumber === true) list.appendChild(reportCard(engine, CHANGE_REQUESTS_REPORT)); })
      .catch(() => {});

    // Compliance evidence packs: the framework-organised, signed pack (one framework or all). It is the
    // same posture report re-projected through a framework's control mapping, so it is customer-specific
    // and as-of-now, not a generic claim.
    root.appendChild(evidencePacksSection(engine));

    return root;
  },
});

// ---------------------------------------------------------------------------
// reportCard: one report. It loads its metadata (generatedAt, period, signature) on
// first paint so the signature-verified state and the period are shown without a click,
// and offers View JSON + Download PDF. The fetched Report is cached so View JSON does not
// re-fetch. A per-card failure is inline (a Retry on the card), never a global error.
// ---------------------------------------------------------------------------

function reportCard(engine: EngineClient, meta: ReportMeta): HTMLElement {
  const card = h("section", { class: "card", "aria-labelledby": `report-${meta.kind}-h`, style: "display:grid;gap:var(--space-3)" });

  // Header: glyph + label + the blurb.
  const header = h("div", { style: "display:flex;gap:var(--space-3);align-items:flex-start" });
  header.appendChild(h("span", { style: "color:var(--text-muted);flex:none;margin-top:2px" }, svgIcon(meta.icon, { size: 20 })));
  const lead = h("div", { style: "display:grid;gap:var(--space-1)" });
  // The label is the card title; when the card carries a tourId, the public tour pins its "?" to the title text.
  lead.appendChild(h("h2", { class: "card__title", id: `report-${meta.kind}-h` }, meta.tourId ? h("span", { dataset: { tourId: meta.tourId } }, meta.label) : meta.label));
  lead.appendChild(h("p", { class: "field__hint measure" }, meta.blurb));
  header.appendChild(lead);
  card.appendChild(header);

  // The metadata + signature slot, filled by the load. Starts as a skeleton.
  const metaHost = h("div", skeletonRows(1));
  card.appendChild(metaHost);

  // The action row: View JSON + Download PDF + Refresh. Disabled until the load succeeds.
  const viewBtn = h("button", { "data-dp": "reports.button.view", class: "btn btn--secondary btn--sm", type: "button", disabled: true }, "View JSON") as HTMLButtonElement;
  const pdfBtn = h("button", { "data-dp": "reports.button.pdf", class: "btn btn--secondary btn--sm", type: "button", disabled: true }, svgIcon(ICON_LICENCE, { size: 14 }), "Download PDF") as HTMLButtonElement;
  const refreshBtn = h("button", { "data-dp": "reports.button.refresh", class: "btn btn--ghost btn--sm", type: "button" }, svgIcon(ICON_REFRESH, { size: 14 }), "Refresh") as HTMLButtonElement;
  const actions = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" }, viewBtn, pdfBtn, refreshBtn);
  card.appendChild(actions);

  // The SLA card is where the RPO/freshness signal lives, so the recovery-TIME (RTO) estimate is
  // surfaced with it (E4/C1: only RPO was surfaced before). The RTO panel sits AFTER the action
  // row so it never splits the card's metadata -> signature -> actions anatomy; it is its own
  // quiet sub-section and loads independently, so a slow or unavailable RTO read never shadows
  // the SLA report's own metadata. Honest by construction: an unknown estimate (no drill
  // history) says so plainly and never fabricates a number.
  if (meta.kind === "sla-compliance") {
    card.appendChild(rtoPanel(engine));
  }

  // The cache is shared by reference between the load (which fills it) and the View/PDF
  // handlers (which read it), so it lives in a one-field holder threaded into both.
  const state: ReportCardState = { cached: null };
  const load = loadReportCard(engine, meta, metaHost, viewBtn, pdfBtn, state);

  viewBtn.addEventListener("click", () => {
    if (state.cached) openJsonView(meta, state.cached);
  });
  pdfBtn.addEventListener("click", () => void downloadPdf(engine, meta, pdfBtn, state.cached?.generatedAt));
  refreshBtn.addEventListener("click", load);

  load();
  return card;
}

interface ReportCardState {
  cached: Report | null;
}

// loadReportCard returns the card's load() function: it skeletons the meta slot, disables the
// View/PDF buttons, then fetches the report and either fills the meta block (caching the report
// for View JSON) or renders a per-card inline error with a Retry (never a global block, since the
// other reports may load fine). The Retry re-runs the same load.
function loadReportCard(
  engine: EngineClient,
  meta: ReportMeta,
  metaHost: HTMLElement,
  viewBtn: HTMLButtonElement,
  pdfBtn: HTMLButtonElement,
  state: ReportCardState,
): () => void {
  const load = (): void => {
    metaHost.replaceChildren(skeletonRows(1));
    viewBtn.disabled = true;
    pdfBtn.disabled = true;
    void engine
      .getReport(meta.kind)
      .then((report) => {
        state.cached = report;
        metaHost.replaceChildren(reportMetaBlock(report));
        viewBtn.disabled = false;
        pdfBtn.disabled = false;
      })
      .catch((err) => {
        if (isUnauthorised(err)) {
          // PAINT FIRST, THEN LEAVE. The two controls were disabled for this read, so they come back
          // with it: a report that never loaded still has a View and a PDF worth pressing after re-auth.
          metaHost.replaceChildren(sessionEnded(load));
          viewBtn.disabled = false;
          pdfBtn.disabled = false;
          return goSignedOut();
        }
        metaHost.replaceChildren(blockError(err, load, { origin: location.origin }));
      });
  };
  return load;
}

// reportMetaBlock renders the loaded report's metadata: when it was generated, the
// reporting period, and the signature-verified state. The signature state is the
// load-bearing assurance read; it is honest about what the console can and cannot assert.
function reportMetaBlock(report: Report): HTMLElement {
  const wrap = h("div", { style: "display:grid;gap:var(--space-2)" });

  // Generated + period.
  const facts = h("div", { style: "display:flex;gap:var(--space-4);align-items:center;flex-wrap:wrap" });
  facts.appendChild(
    h(
      "span",
      { class: "field__hint", title: absoluteTime(report.generatedAt) },
      `Generated ${relativeTime(report.generatedAt)}`,
    ),
  );
  facts.appendChild(h("span", { class: "field__hint" }, periodPhrase(report)));
  wrap.appendChild(facts);

  // The signature-verified state: a dot + label by hue + shape + text. The detail
  // paragraph renders only for the degraded states (not signed / unrecognised scheme),
  // where it is the honesty carrier; a cleanly signed report does not repeat the
  // scheme/verify sentence on every card (it is stated once in the screen's quiet note).
  const sig = signatureState(report.signature);
  const sigRow = h("div", { style: "display:grid;gap:var(--space-2)" });
  const sigLine = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
  sigLine.appendChild(statusWithLabel(sig.tone, sig.label));
  // The chip renders only for the degraded states (warn "unrecognised scheme", neutral "not
  // signed"): on a cleanly signed report the trust dot + "Signed, tamper-evident" already says
  // it, and a second green "signed" chip beside it was the same fact twice.
  if (sig.tone !== "trust") sigLine.appendChild(signatureBadge(sig.tone, sig.signed));
  sigRow.appendChild(sigLine);
  if (!sig.signed || sig.tone !== "trust") sigRow.appendChild(h("p", { class: "field__hint measure" }, sig.detail));

  // When signed, surface the signature value (a redaction-safe public artefact: a
  // signature over names/counts/timestamps, never a secret) so an auditor can copy it to
  // verify against the published release/engine signer out of band.
  if (sig.signed && report.signature) {
    const sigValue = h("div", { style: "display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap" });
    sigValue.appendChild(h("span", { class: "section-label" }, "Signature"));
    sigValue.appendChild(h("code", { class: "mono", style: "overflow-wrap:anywhere;font-size:var(--text-sm)" }, truncateMiddle(report.signature, 48)));
    sigValue.appendChild(copyButton("Copy the report signature", () => report.signature ?? ""));
    sigRow.appendChild(sigValue);
  }

  wrap.appendChild(sigRow);
  return wrap;
}

// openJsonView shows the report's full JSON in a modal, pretty-printed in a code block
// (textContent, so no markup is parsed), with a copy button. The JSON is the customer's
// own data (names, counts, timestamps, signature); no custody concern.
function openJsonView(meta: ReportMeta, report: Report): void {
  const json = safeStringify(report);
  const body = h("div", { class: "stack", style: "display:grid;gap:var(--space-3)" });
  body.appendChild(
    h(
      "p",
      { class: "field__hint measure" },
      "The full report as JSON, exactly as the engine emitted it. The signature, when present, is over the engine's canonical serialisation of {kind, generatedAt, period, data}. This is your own data: names, counts and timestamps only.",
    ),
  );
  body.appendChild(codeBlock(json, { copyLabel: "Copy the report JSON" }));

  openModal({
    title: `${meta.label} report (JSON)`,
    body,
    // Wide: pretty-printed JSON lines are long, and the standard measure forced a
    // horizontal scroll inside the code block.
    wide: true,
    actions: [{ label: "Close", variant: "secondary", onClick: () => {} }],
  });
}

// downloadPdf fetches the rendered PDF bytes and triggers a browser download. The bytes
// are generated in-account; a non-2xx is named honestly by the api layer (it routes
// through failResponse so an Access-redirect body is not read as a corrupt PDF). The
// filename carries the loaded report's generatedAt date so a monthly download never
// collides into "(1)" copies of indistinguishable artefacts.
async function downloadPdf(engine: EngineClient, meta: ReportMeta, btn: HTMLButtonElement, generatedAt?: string): Promise<void> {
  // Snapshot the original children (the icon + label) so the busy state restores exactly,
  // including the icon, regardless of the original content.
  const original = Array.from(btn.childNodes);
  btn.disabled = true;
  btn.replaceChildren(document.createTextNode("Preparing"));
  try {
    const bytes = await engine.getReportPDF(meta.kind);
    const datePart = generatedAt && /^\d{4}-\d{2}-\d{2}/.test(generatedAt) ? `-${generatedAt.slice(0, 10)}` : "";
    downloadBytes(`downpipes-report-${meta.kind}${datePart}.pdf`, bytes, "application/pdf");
    toast({ message: `${meta.label} PDF downloaded` });
  } catch (err) {
    if (isUnauthorised(err)) {
      goSignedOut();
      return;
    }
    toast({ message: `Could not download the ${meta.label} PDF (${errText(err)}).`, tone: "warn" });
  } finally {
    btn.disabled = false;
    btn.replaceChildren(...original);
  }
}

