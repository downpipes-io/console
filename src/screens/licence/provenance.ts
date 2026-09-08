// The two demoted (collapsed) bodies of the Licence and updates screen: the Provenance body (artefact
// traceability and the release-signer scheme) and the Enterprise services body (shown to a
// Community operator). The Provenance body reads the engine's self-stamped facts and labels honestly
// anything it does not yet report; the Enterprise body holds the screen's one place the security-feature list
// appears, with the fixed framing that the product and all its security are free and included and Enterprise
// adds services, assurance and support, not features. Moved verbatim from the licence coordinator for size;
// copy and markup are unchanged. House rules: Australian English, no em dashes, precise claims
// ("tamper-evident", "post-quantum hybrid").

import { recordWireAnomaly } from "../../lib/client-diag/ring.ts";
import { h } from "../../lib/dom.ts";
import { openLicencesDialog } from "../../components/licences-dialog.ts";
import {
  ENTERPRISE_CONTACT,
  ENTERPRISE_SERVICES,
} from "../../lib/billing.ts";
import { consoleVersion } from "../../lib/console-version.ts";
import { type LicenceData, artefactHashState } from "./shared.ts";
import { detailRow, detailRowNode, provenancePlaceholder } from "./detail-rows.ts";
import type { StatusReport, UpdateProvenance, UpdateStatusRecord } from "../../api.ts";

// renderProvenanceBody shows the provenance and verification state inside its
// collapsed section (the summary carries the heading). This body pairs the two
// component identities (the engine's reported version and THIS console's own
// baked version, multi-component P1) with the artefact traceability and the
// signer scheme; fail-open and pull-not-push are stated in their owning
// sections, not re-opened here. Fields the engine does not yet report are labelled
// honestly as placeholders so the section never claims more than it knows.
export function renderProvenanceBody(data: LicenceData): HTMLElement {
  const card = h("div");

  // Component versions side by side: the engine's own report, and the version baked into THIS bundle by
  // the build stamp (scripts/stamp-build.mjs). An unstamped build (a dev build without the define) states
  // that honestly rather than fabricating a version; the served release bundle is always stamped.
  card.appendChild(detailRow("Engine version", data.status.engineVersion));
  const ownVersion = consoleVersion();
  if (ownVersion !== null) {
    card.appendChild(detailRow("Console version", ownVersion));
  } else {
    card.appendChild(detailRowNode("Console version", provenancePlaceholder("not stamped into this build (a dev or hand-rolled build without the version define)")));
  }

  // Artefact hash: the engine now SELF-STAMPS the SHA-384 of its own deployable bundle and reports it
  // (status.artefactSha384). Render the REAL hash when present (mono, wrappable so a 96-char digest does not
  // overflow); when genuinely absent (an unstamped dev/non-release build, or an older engine) keep an HONEST
  // "not reported" placeholder, we read the field, never fabricate a value.
  const hash = artefactHashState(data.status);
  if (hash) {
    const hashEl = h("code", { class: "mono", style: "display:block;word-break:break-all;line-height:var(--leading-snug)" });
    hashEl.textContent = hash;
    card.appendChild(detailRowNode("Artefact hash (SHA-384)", hashEl));
    card.appendChild(
      h(
        "p",
        { class: "field__hint", style: "margin-top:var(--space-1)" },
        "This is the engine's build-stamped digest of its own deployable bundle, cross-check it against the published release. It is for traceability; the hash that GATES an update is the signed channel's, verified before any deploy.",
      ),
    );
  } else if (artefactStampMalformed(data.status)) {
    // PRESENT but not a SHA-384: a build-provenance fault, NOT the benign "unstamped build" the
    // placeholder below describes. The two used to render identically, so a corrupted stamp read as an
    // ordinary dev build and nobody looked. The malformed value itself is never rendered.
    //
    // The raw stamp rides at the top of the pack (section 3, engine.artefactSha384), so the evidence is
    // there and nothing has ever pointed at it. This row does. The malformed value has no field on the record and
    // it must not get one: a corrupted stamp is exactly the value that is not to be trusted.
    recordWireAnomaly("artefact-sha", "unparseable");
    card.appendChild(detailRowNode("Artefact hash (SHA-384)", provenancePlaceholder("reported but unreadable")));
    card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, ARTEFACT_STAMP_MALFORMED_LINE));
  } else {
    card.appendChild(detailRowNode("Artefact hash (SHA-384)", provenancePlaceholder("not reported by this build (a non-release or unstamped build does not carry a stamped digest)")));
  }

  // Release-signer pin: the engine reports the PUBLIC release-signer pin (status.releaseSignerPin) when
  // set, render it mono so it can be cross-checked against the published pin. The scheme note (the
  // post-quantum hybrid + the channel verify state) is shown regardless; the pin value is additive.
  const signerNote = data.updates.configured && data.updates.verified
    ? "Ed25519 + ML-DSA-87 hybrid (post-quantum); verified via update channel"
    : data.updates.configured
      ? "Ed25519 + ML-DSA-87 hybrid (post-quantum); update channel configured, not yet verified"
      : "Ed25519 + ML-DSA-87 hybrid (post-quantum); update channel not configured";
  card.appendChild(detailRow("Release-signer scheme", signerNote));
  const pin = data.status.releaseSignerPin?.trim();
  if (pin) {
    const pinEl = h("code", { class: "mono", style: "display:block;word-break:break-all;line-height:var(--leading-snug)" });
    pinEl.textContent = pin;
    card.appendChild(detailRowNode("Release-signer pin", pinEl));
  }

  // Build provenance: rendered from the SIGNED channel's provenance block plus this account's own
  // verified-apply record, in three honest states -- real identifiers with openable links when the channel
  // publishes provenance; this account's recorded digest + read-back verdict when an apply has settled
  // with evidence; and the plain not-published placeholder otherwise. Never a dangling link, never an
  // invented value.
  const prov = data.updates.provenance;
  // https-only, matching the engine's own channel-fetch discipline: a base that is not a public
  // https url never becomes an href or a fetch target here, whatever the engine reported.
  const channelBase = typeof data.updates.channelBase === "string" && data.updates.channelBase.startsWith("https://") ? data.updates.channelBase : null;
  if (prov !== undefined) {
    card.appendChild(renderReleaseProvenance(prov, channelBase, data.updates.recommendedVersion ?? null));
  } else {
    card.appendChild(detailRowNode("Build provenance", provenancePlaceholder("not published for this release; the signed channel's digest is what gates an update, verified in this account before any deploy")));
  }

  // Verified apply record: what THIS account proved at its last settled update -- the signed
  // digest the apply enforced, and whether Cloudflare's own API returned those exact bytes before
  // promotion. This is the customer-side half of the provenance story: it lives in the account's own
  // hash-chained records, not in a vendor claim.
  const lastRecord = data.updateState?.last ?? null;
  // Two of the outcomes belong here for the same reason the other two do: both PROMOTED a version and
  // both recorded the digest they enforced, so this account's own evidence of which bytes went live exists
  // and was being withheld on exactly the two outcomes an operator would go looking for it after.
  if (lastRecord !== null && (lastRecord.outcome === "applied" || lastRecord.outcome === "rolled-back" || lastRecord.outcome === "rollback-failed" || lastRecord.outcome === "applied-unconfirmed")) {
    card.appendChild(renderVerifiedApply(lastRecord, channelBase, prov));
  }

  card.appendChild(
    h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-4)" },
      "Tamper-evident here means the engine produces a hash-chained audit log (D4) and the recovery archive carries a detached signature; it does not mean an independent runtime attestation is available from Cloudflare. What binds the running deployment to a release today is the signed channel digest, verified in this account before any deploy, and the canary that follows it.",
    ),
  );

  // Open-source acknowledgements: a quiet link to the bill of materials. The
  // product is source-available and built on others' work; this names every
  // dependency, with its licence, and offers a downloadable SBOM. Kept here in
  // Provenance because it is part of "what this build is made of".
  const licWrap = h("div", {
    style: "margin-top:var(--space-4);padding-top:var(--space-3);border-top:1px solid var(--border-subtle)",
  });
  const licBtn = h("button", { "data-dp": "licence.button.lic", class: "btn btn--ghost btn--sm", type: "button" }, "Open-source licences and acknowledgements");
  licBtn.addEventListener("click", () => openLicencesDialog());
  licWrap.appendChild(licBtn);
  licWrap.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "Every dependency the product is built on, with its licence, and a downloadable SBOM."),
  );
  card.appendChild(licWrap);

  return card;
}

// renderReleaseProvenance builds the "Release provenance" sub-block from the SIGNED channel's
// provenance block: the public build identifiers for the recommended release, each an openable link
// when its target is derivable (commit/run need the repo; attestation files need the channel base),
// otherwise honest mono text. Every value here rode inside the signed channel, so the pinned release
// key vouches for it; nothing is fabricated client-side.
function renderReleaseProvenance(prov: UpdateProvenance, channelBase: string | null, recommendedVersion: string | null): HTMLElement {
  const wrap = h("div", { style: "margin-top:var(--space-4)" });
  wrap.appendChild(h("p", { style: "color:var(--text)" }, `Release provenance${recommendedVersion !== null ? ` for ${recommendedVersion}` : ""}`));
  const monoOrLink = (label: string, text: string, href: string | null): void => {
    if (href !== null) {
      wrap.appendChild(detailRowNode(label, h("a", { class: "mono", href, target: "_blank", rel: "noopener noreferrer", style: "word-break:break-all" }, text)));
    } else {
      const code = h("code", { class: "mono", style: "display:block;word-break:break-all;line-height:var(--leading-snug)" });
      code.textContent = text;
      wrap.appendChild(detailRowNode(label, code));
    }
  };
  // Runtime string narrowing on every field before it is sliced, linked or rendered: the v2
  // components path sanitises provenance engine-side, but the legacy artefacts[] fallback passes
  // the parsed block through raw, and a signed-but-garbled value must degrade to absence here,
  // never throw the screen (the CP renderer applies the same rule).
  const s = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const commit = s(prov.commit);
  const tag = s(prov.tag);
  const repo = s(prov.repo);
  const runId = s(prov.runId);
  const rekor = s(prov.rekorLogIndex);
  if (commit !== undefined) monoOrLink("Source commit", commit, repo !== undefined ? `https://github.com/${repo}/commit/${encodeURIComponent(commit)}` : null);
  if (tag !== undefined) wrap.appendChild(detailRow("Release tag", repo !== undefined ? `${tag} (${repo})` : tag));
  if (runId !== undefined) monoOrLink("Build run (CI)", runId, repo !== undefined ? `https://github.com/${repo}/actions/runs/${encodeURIComponent(runId)}` : null);
  if (rekor !== undefined) monoOrLink("Transparency log (Rekor)", `log index ${rekor}`, `https://search.sigstore.dev/?logIndex=${encodeURIComponent(rekor)}`);
  const rawAtt = prov.attestations;
  const att = typeof rawAtt === "object" && rawAtt !== null && !Array.isArray(rawAtt) ? rawAtt : undefined;
  if (att !== undefined) {
    const entries: Array<[string, string | undefined]> = [
      ["SLSA provenance", s(att.intoto)],
      ["signature bundle", s(att.cosignBundle)],
      ["checksums", s(att.sums)],
      ["release record", s(att.releaseRecord)],
    ];
    const present = entries.filter((e): e is [string, string] => e[1] !== undefined);
    if (present.length > 0) {
      const row = h("p", { class: "field__hint", style: "margin-top:var(--space-2)" }, "Attestations on the update channel: ");
      present.forEach(([label, p], i) => {
        if (i > 0) row.appendChild(document.createTextNode(" · "));
        row.appendChild(channelBase !== null ? h("a", { href: channelBase + p, target: "_blank", rel: "noopener noreferrer" }, label) : h("span", `${label} (${p})`));
      });
      wrap.appendChild(row);
    }
  }
  wrap.appendChild(
    h("p", { class: "field__hint", style: "margin-top:var(--space-1)" }, "These identifiers ride inside the signed channel, so the pinned release key vouches for them. The digest that gates an apply remains the signed channel's, verified in this account before any deploy."),
  );
  return wrap;
}

// renderVerifiedApply builds the "Verified apply (this account)" sub-block from the engine's own
// persisted lifecycle record: the signed digest the apply enforced, the platform read-back verdict,
// and (on demand, never automatically) a cross-check against the published release record. This is the
// customer-side half of the provenance story: evidence recorded in this account's own hash-chained
// records at apply time, not a vendor claim rendered after the fact.
function renderVerifiedApply(last: NonNullable<UpdateStatusRecord["last"]>, channelBase: string | null, prov: UpdateProvenance | undefined): HTMLElement {
  const wrap = h("div", { style: "margin-top:var(--space-4)" });
  wrap.appendChild(h("p", { style: "color:var(--text)" }, "Verified apply (this account)"));
  const versionLabel = last.recommendedVersion ?? "(unknown version)";
  // Each outcome names itself. A two-way ternary read every non-"applied" outcome as "rolled back", which
  // is the reassuring word for the one state where the rollback did NOT happen.
  const outcomeWord =
    last.outcome === "applied"
      ? "applied"
      : last.outcome === "rollback-failed"
        ? "rollback FAILED, still live on"
        : last.outcome === "applied-unconfirmed"
          ? "deployed, live version unconfirmed:"
          : "rolled back";
  wrap.appendChild(detailRow("Outcome", `${outcomeWord} ${versionLabel}`));
  if (typeof last.artefactSha384 === "string" && last.artefactSha384 !== "") {
    const digestEl = h("code", { class: "mono", style: "display:block;word-break:break-all;line-height:var(--leading-snug)" });
    digestEl.textContent = last.artefactSha384;
    wrap.appendChild(detailRowNode("Signed digest (SHA-384)", digestEl));
  } else {
    wrap.appendChild(detailRowNode("Signed digest (SHA-384)", provenancePlaceholder("recorded before content-hash evidence; the next apply records its digest automatically")));
  }
  if (last.readback !== undefined && typeof last.readback === "object") {
    const rb = last.readback;
    const platformDigest = typeof rb.deployedSha384 === "string" && rb.deployedSha384 !== "" ? rb.deployedSha384 : undefined;
    const detail = typeof rb.detail === "string" && rb.detail !== "" ? rb.detail : undefined;
    const line =
      rb.verdict === "verified"
        ? "verified: Cloudflare's own API returned byte-exact the signed bundle before promotion"
        : rb.verdict === "mismatch"
          ? `mismatch: the platform's bytes differed from the signed digest${platformDigest !== undefined ? ` (platform ${platformDigest.slice(0, 16)}…)` : ""}; treat as an incident if unexplained`
          : `not available for that apply${detail !== undefined ? ` (${detail})` : ""}; recorded honestly rather than assumed`;
    wrap.appendChild(detailRow("Platform read-back", line));
  }
  // The release-record cross-check, as a MANUAL comparison against a link rather than an in-browser
  // fetch.
  //
  // It used to be a button that fetched channelBase + recordPath and compared digests automatically.
  // That control was DEAD in the shipped console and had been since it landed: buildCsp() sets
  // connect-src to exactly 'self' (src/worker.ts), so Chromium blocked the request before the network
  // and every click fell into the catch. Worse, the one line it could still emit said "the channel
  // host may not allow browser reads from this origin", which blames the channel for the console's
  // own policy. Nothing caught it because the tests that cover this file replace globalThis.fetch, so
  // the CSP was never in the path.
  //
  // It is not proxied through the console Worker the way the claim-code exchange now is. channelBase
  // comes from the engine's own UPDATE_CHANNEL_URL (engine/src/admin/updates.ts:769), so it is
  // operator-configurable: a Worker route that fetched it would let whoever sets that variable aim
  // the console's server side at any host, which is an SSRF surface bought for a convenience.
  //
  // So the digest is shown plainly, next to the record link that already sits above, and the operator
  // compares two strings. That is less convenient and it is true, which is the trade this console
  // makes everywhere else.
  const rawRecordPath = prov?.attestations?.releaseRecord;
  const recordPath = typeof rawRecordPath === "string" && rawRecordPath !== "" ? rawRecordPath : undefined;
  const expected = typeof last.artefactSha384 === "string" ? last.artefactSha384 : "";
  if (channelBase !== null && recordPath !== undefined && expected !== "") {
    const hint = h(
      "p",
      { class: "field__hint", style: "margin-top:var(--space-2)", "data-dp": "licence.hint.verified-apply" },
      "To confirm this build against the published record, open the release-record link above and compare its engine digest with the one this account verified at apply time:",
    );
    const digest = h("code", { class: "mono", style: "display:block;margin-top:var(--space-1);word-break:break-all" }, expected);
    wrap.appendChild(hint);
    wrap.appendChild(digest);
  }
  return wrap;
}


// renderEnterpriseBody builds the Enterprise services body shown to a
// Community operator inside its collapsed section (the summary carries the
// heading). The framing is fixed: the product and all its security are FREE and
// included; Enterprise adds SERVICES, assurance and support, NOT features. This is
// the ONE place the security-feature list appears on the screen. Enterprise is
// invoice-billed and licences are issued by the vendor; the CTA is a
// plain external link (mailto or https) to ENTERPRISE_CONTACT.
export function renderEnterpriseBody(): HTMLElement {
  const card = h("div");

  card.appendChild(
    h(
      "p",
      { style: "color:var(--text)" },
      "The product is free and so is all of its security. SSO, MFA, Cloudflare Access, RBAC, the tamper-evident audit log and the no-custody post-quantum crypto are included for every organisation at the Community tier, with nothing held back. Enterprise is an optional paid subscription that adds services, assurance and support around the product you already run, not extra product features.",
    ),
  );

  // The services list: people-and-paperwork services plus signed assurance over the
  // recovery path the product already provides.
  card.appendChild(h("p", { class: "field__hint", style: "margin-top:var(--space-3)" }, "What an Enterprise subscription adds:"));
  // list-style/padding/margin via CSSOM-safe inline style (the h() builder sets each
  // property with setProperty, which the strict CSP allows), matching the list idiom used
  // elsewhere (access-security.ts). No injected stylesheet, no .cssText.
  const list = h("ul", { style: "list-style:disc;padding-left:var(--space-5);margin-top:var(--space-2);display:flex;flex-direction:column;gap:var(--space-1)" });
  for (const item of ENTERPRISE_SERVICES) list.appendChild(h("li", item));
  card.appendChild(list);

  // CTA: a plain external link to talk to us. mailto or https are both fine here.
  // A lone action, not a label/value pair: a plain margin wrapper (no .kv-row grid hairline).
  card.appendChild(
    h(
      "div",
      { style: "margin-top:var(--space-4)" },
      h("a", { class: "btn btn--primary btn--sm", href: ENTERPRISE_CONTACT, target: "_blank", rel: "noopener noreferrer" }, "Talk to us about Enterprise"),
    ),
  );

  return card;
}

// artefactStampMalformed separates artefactHashState's two null cases. Both render as the same
// "not stamped" placeholder, but they are DIFFERENT facts: an ABSENT artefactSha384 is an older or
// unstamped engine build (expected, benign), while a PRESENT one that is not 96 hex characters is a
// build-provenance fault (a truncated or corrupted stamp) that this card was quietly disarming. This
// predicate is true only for the second, so the card can name it. The malformed value is never
// rendered, only the verdict. Pure; exported for the validator (via the licence barrel).
export function artefactStampMalformed(status: StatusReport): boolean {
  const raw = status.artefactSha384;
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "string") return true;
  if (raw.trim() === "") return false; // an empty stamp is an absent one, not a corrupted one
  return artefactHashState(status) === null;
}

// ARTEFACT_STAMP_MALFORMED_LINE is what the provenance card says when artefactStampMalformed is true.
export const ARTEFACT_STAMP_MALFORMED_LINE =
  "Your engine reported a build stamp the console cannot read (it is not a SHA-384 digest), so this build's artefact cannot be compared against the published one. The raw value travels in a support pack.";
