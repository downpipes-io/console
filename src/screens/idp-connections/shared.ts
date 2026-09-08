// Shared leaf helpers, constants and the small presenters for the external-identity-providers screen
// (the route constant, the owner-reserved capability the engine gates connection management on, the kind
// label/badge presenters, the secret-mode note, the engine-reason capitaliser, the PEM splitter, and the
// tiny error-text and file-download utilities). These are the building blocks more than one section module
// reaches for, so they live in this leaf and no section module imports another section module (which would
// form a cycle): the list section and the forms section each import one way from here. Moved verbatim from
// the idp-connections coordinator for size; behaviour, copy and markup are unchanged.
//
// House rules: Australian English, no em dashes, precise claims.

import { h, svgIcon } from "../../lib/dom.ts";
import { badge } from "../../components/status.ts";
import { ICON_LOCK } from "../../lib/icons.ts";
import type { IdpKind } from "../../api.ts";

export const ROUTE_IDP = "/access/idp";

// The capability the engine gates connection management on. keys.ceremony is owner-reserved (a group can
// confer access.policy, never keys.ceremony), so a group-conferred access-admin cannot wire a hostile
// connection and self-escalate. The console mirrors exactly this gate; the engine enforces.
export const MANAGE_CAP = "keys.ceremony" as const;

// TakenConnIds is the set of connection ids ALREADY configured on this engine, or null/undefined when the
// console could not establish it. The absent case is not decoration: an id-collision rule applied against a
// list the console does not really have would refuse a free id, which is worse than the defect it closes.
// UNDEFINED IS IN THE UNION DELIBERATELY, and a driven test found out why: a caller that simply does not
// pass the set must land on "I do not know" rather than throwing inside the validator, which is what a
// non-optional parameter produced the moment an existing test called the form with three arguments.
export type TakenConnIds = ReadonlySet<string> | null | undefined;

// connIdError is the shared Connection id validator for both add forms (the preset form and the SAML
// form), which carried identical copies of the shape rule and NEITHER of which looked at what already
// exists. The engine refuses a collision at engine/src/admin/idpconn.ts:59, and it does so at SUBMIT: driven
// against engine main through the production handleAdmin with the flat preset body the console really
// posts, the same id twice answers 200 {ok:true} and then 200 {ok:false, reason: 'a connection with id
// "okta-prod" already exists'}, so the operator loses a filled form to a value the console could have
// refused as they typed it.
//
// The collision is easy to reach rather than exotic: both forms PRE-FILL the id (the preset id, or
// "saml"), so pressing "Add another Okta" opens a form already holding the taken id.
//
// The shape half mirrors the engine's CONN_ID_PATTERN and is unchanged. The collision half applies only
// when `taken` is a real set; when it is null the console says nothing about collisions, because it does
// not know, and the engine's own refusal still arrives at the form verbatim.
export function connIdError(v: string, taken?: TakenConnIds): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(v)) return "Use 1 to 64 lowercase letters, numbers or hyphens, starting and ending with a letter or number.";
  if (taken?.has(v)) return `This engine already has a connection with the id "${v}". Give this one a different id, for example by adding your environment or tenant to it.`;
  return null;
}

// kindLabel / kindBadge present a connection kind in human terms.
export function kindLabel(kind: IdpKind): string {
  return kind === "oidc" ? "OpenID Connect" : kind === "oauth2" ? "OAuth 2.0" : "SAML 2.0";
}
export function kindBadge(kind: IdpKind): HTMLElement {
  return badge("info", kind === "oidc" ? "OIDC" : kind === "oauth2" ? "OAuth2" : "SAML");
}

// secretModeNote renders the secret MODE as a tiny inline note (never a value). A confidential client
// shows a lock; a public (PKCE) client shows that it holds no secret.
export function secretModeNote(mode: string): HTMLElement {
  if (mode === "pkce-public") return h("span", { class: "field__hint", style: "display:inline-flex;gap:var(--space-1);align-items:center" }, "public client, no secret");
  return h("span", { class: "field__hint", style: "display:inline-flex;gap:var(--space-1);align-items:center" }, svgIcon(ICON_LOCK, { size: 12 }), "secret stored (write-only)");
}

// splitPems splits a paste of one or more PEM certificates into a string[] of complete PEM blocks. A
// trailing newline / surrounding whitespace is tolerated; non-PEM noise between blocks is dropped. It is a
// PURE function so the validator can pin it (a single cert, multiple certs, whitespace, and empty input).
export function splitPems(text: string): string[] {
  const out: string[] = [];
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    out.push(m[0].trim());
    m = re.exec(text);
  }
  return out;
}

// pemBlocksIntended counts the certificate blocks the operator MEANT to paste, by counting the BEGIN markers.
// It is the DENOMINATOR splitPems has never had (G308).
//
// splitPems keeps only what its regex matched end to end, and drops everything else on the floor: a block whose
// END line an editor mangled (a wrapped line, a stray character, a truncated paste) does not match, so the block
// is silently discarded and the submission is SMALLER THAN THE PASTE. Nobody is told. At the next certificate
// rotation, weeks later, sign-in breaks against a cert the IdP is now signing with and the console never stored,
// and the SSO failure the engine records points at the KEY, which is the wrong end of the problem entirely.
//
// Counting BEGIN markers is the honest measure of intent: an operator pastes N certificates and each carries one.
// A paste with more BEGINs than blocks lost the difference. Pure; the certificate bodies are never read.
export function pemBlocksIntended(text: string): number {
  return (text.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
}

// capitalise upper-cases the first letter of an engine reason for display (the reasons arrive lower-case,
// e.g. "provide the required value(s): host, realm").
export function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// errText now lives in lib/errors.ts; re-exported here so the IdP screens keep their local import.
export { errText } from "../../lib/errors.ts";

export function downloadText(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
