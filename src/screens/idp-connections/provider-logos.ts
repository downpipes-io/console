// The provider catalogue presentation layer for the external-identity-providers screen: the canonical
// provider KEY normaliser, the popularity ORDER, and the inline-SVG brand MARKS the tile grid renders.
//
// WHY a normaliser: a connection carries a presetId and the catalogue carries a preset id, but the two can
// spell the same provider differently (the engine ships "entra"; an older seed says "entra-oidc"), and a
// SAML connection has no preset at all (it is keyed on its kind). providerKey() folds every spelling onto
// ONE stable key so a tile and the connection(s) that configured it always line up, in the demo and in
// production alike. The vendor checks run BEFORE the generic protocol checks so "entra-oidc" reads as Entra
// (not the generic OIDC) and "github-oauth2" as GitHub (not the generic OAuth2).
//
// WHY local marks: these are the recognisable SSO provider logos shown nominatively, the same "you can sign
// in with X" affordance every SSO screen carries, so an owner spots their provider at a glance. The marks
// are small, in-repo SVG constants (never server data), rendered through brandSvg below; the screen prints a
// trademark-ownership line beneath the grid. Path data for the named vendors is the CC0 Simple Icons
// silhouette; the iconic multi-colour Microsoft and Google marks and the JumpCloud, OAuth and generic SAML
// marks are composed here. Every logo is decorative (aria-hidden): the visible provider NAME beside it is
// the accessible label, so a screen reader is not made to announce the mark twice.
//
// House rules: Australian English, no em dashes, precise claims.

import { recordContractSkew } from "../../lib/client-diag/ring.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// The eleven providers the screen knows by name: the ten engine presets (oidc-presets.ts) folded onto a
// vendor/protocol key, plus "saml" (the generic SAML 2.0 path, which has no preset). "oidc" is the generic
// OpenID preset and "oauth" the generic OAuth2 preset.
export type ProviderKey =
  | "entra" | "okta" | "google" | "github" | "auth0" | "gitlab"
  | "keycloak" | "jumpcloud" | "saml" | "oidc" | "oauth";

// PROVIDER_META carries the display name and the popularity RANK (the grid orders ascending by rank). The
// rank is the order an enterprise team most often reaches for: the big directories first (Entra, Okta,
// Google), SAML next as the dominant federation protocol, then the named vendors, with the two generic
// protocol catch-alls (OpenID, OAuth2) last. label is the tile caption.
export const PROVIDER_META: Record<ProviderKey, { label: string; rank: number }> = {
  entra: { label: "Microsoft Entra ID", rank: 1 },
  okta: { label: "Okta", rank: 2 },
  google: { label: "Google Workspace", rank: 3 },
  saml: { label: "SAML 2.0", rank: 4 },
  auth0: { label: "Auth0", rank: 5 },
  github: { label: "GitHub", rank: 6 },
  gitlab: { label: "GitLab", rank: 7 },
  jumpcloud: { label: "JumpCloud", rank: 8 },
  keycloak: { label: "Keycloak", rank: 9 },
  oidc: { label: "Generic OIDC", rank: 10 },
  oauth: { label: "Generic OAuth2", rank: 11 },
};

// providerKey folds a connection or a preset/connection id onto its canonical ProviderKey, or null when it
// matches none (a future engine preset the console does not recognise; the grid gives it a neutral fallback
// mark). A SAML connection is keyed on its kind (it has no vendor preset). For an id STRING the vendor
// substrings are tested BEFORE the generic "oidc"/"oauth"/"saml" substrings, so "entra-oidc" -> entra and
// "github-oauth2" -> github rather than the generic protocol keys.
export function providerKey(input: string | { kind?: string; presetId?: string }): ProviderKey | null {
  if (typeof input !== "string") {
    if (input.kind === "saml") return "saml";
    return resolveId(input.presetId ?? "");
  }
  return resolveId(input);
}

// resolveId is keyFromId PLUS the drift record, and it is the RESOLUTION site, which is the only place the
// unknown-preset state is visible.
//
// THE RECORD USED TO SIT AT THE RENDER SITE, AND IT COULD NEVER FIRE. providerLogo tested
// `key !== null && MARKS[key] === undefined`, but MARKS is a TOTAL map over the closed ProviderKey union, with
// completeness enforced by tsc: for any non-null key, MARKS[key] is always defined. The condition was
// unsatisfiable, and the state it was written for -- an engine preset id this console build cannot resolve --
// does not reach it at all, because keyFromId falls through to NULL and null was explicitly excluded as "the
// honest no-preset case". That exclusion was backwards. A raw SAML connection does NOT resolve to null (kind
// "saml" returns "saml", and any id containing saml/oidc/oauth maps to a real key), so null is reached ONLY for
// an id this build cannot resolve. NULL IS THE DRIFT CASE, and it was the one case suppressed.
//
// An EMPTY id stays silent, and that is the genuine no-preset case: nothing was asserted, so nothing is unknown,
// and recording it would cry wolf on every connection that simply has no vendor preset. The id itself never
// rides: it is tested for emptiness and a closed member is recorded.
function resolveId(idRaw: string): ProviderKey | null {
  const key = keyFromId(idRaw);
  if (key === null && idRaw.trim() !== "") recordContractSkew("unknown-enum-member", "idp-preset");
  return key;
}

function keyFromId(idRaw: string): ProviderKey | null {
  const id = idRaw.toLowerCase();
  // Vendor checks first (a vendor id may also contain "oidc"/"oauth"); auth0 before any "okta" vendor note.
  if (id.includes("auth0")) return "auth0";
  if (id.includes("entra") || id.includes("microsoft") || id.includes("azure")) return "entra";
  if (id.includes("okta")) return "okta";
  if (id.includes("google")) return "google";
  if (id.includes("github")) return "github";
  if (id.includes("gitlab")) return "gitlab";
  if (id.includes("keycloak")) return "keycloak";
  if (id.includes("jumpcloud")) return "jumpcloud";
  // Generic protocol catch-alls last.
  if (id.includes("saml")) return "saml";
  if (id.includes("oidc")) return "oidc";
  if (id.includes("oauth")) return "oauth";
  return null;
}

// brandSvg builds an <svg> from a trusted, in-repo brand-mark constant. It is the FILLED-mark sibling of
// dom.ts svgIcon (which forces a single currentColor STROKE and so cannot render a multi-colour filled
// logo). The markup is an in-repo constant, never server-supplied, so innerHTML over it is safe (the same
// rationale svgIcon documents). The mark is decorative: aria-hidden is set, because the provider name beside
// it is the visible, accessible label.
function brandSvg(inner: string, viewBox: string, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("idp-logo");
  svg.innerHTML = inner;
  return svg;
}

// The brand marks, keyed by ProviderKey. A "mono" mark uses fill="currentColor" so it inherits the tile's
// text colour and stays legible in both the light and the Obsidian (dark) skins (the right call for GitHub
// and Keycloak, whose marks are essentially monochrome). The rest carry their official brand colours.
interface Mark { inner: string; viewBox: string }

const MARKS: Record<ProviderKey, Mark> = {
  // Microsoft: the four-square mark in the official tile colours (composed here; the single-path silhouette
  // would lose the colours that make it instantly Microsoft).
  entra: {
    viewBox: "0 0 24 24",
    inner:
      '<rect x="1" y="1" width="10" height="10" fill="#F25022"/>' +
      '<rect x="13" y="1" width="10" height="10" fill="#7FBA00"/>' +
      '<rect x="1" y="13" width="10" height="10" fill="#00A4EF"/>' +
      '<rect x="13" y="13" width="10" height="10" fill="#FFB900"/>',
  },
  // Okta: the ring mark (CC0 Simple Icons silhouette) in Okta blue.
  okta: {
    viewBox: "0 0 24 24",
    inner:
      '<path fill="#007DC1" d="M12 0C5.389 0 0 5.35 0 12s5.35 12 12 12 12-5.35 12-12S18.611 0 12 0zm0 18c-3.325 0-6-2.675-6-6s2.675-6 6-6 6 2.675 6 6-2.675 6-6 6z"/>',
  },
  // Google: the four-colour "G" (composed here; the iconic multi-colour form).
  google: {
    viewBox: "0 0 48 48",
    inner:
      '<path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>' +
      '<path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>' +
      '<path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>' +
      '<path fill="#EA4335" d="M24 9.5c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 2.93 29.93.5 24 .5 15.4.5 7.96 5.43 4.34 12.62l7.35 5.7C13.42 13.12 18.27 9.5 24 9.5z"/>',
  },
  // GitHub: the Octocat mark (CC0 Simple Icons silhouette), mono so it themes (its brand is black/white).
  github: {
    viewBox: "0 0 24 24",
    inner:
      '<path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
  },
  // Auth0: the three-streak mark (CC0 Simple Icons silhouette) in Auth0 orange.
  auth0: {
    viewBox: "0 0 24 24",
    inner:
      '<path fill="#EB5424" d="M21.98 7.448L19.62 0H4.347L2.02 7.448c-1.352 4.312.03 9.206 3.815 12.015L12.007 24l6.157-4.552c3.755-2.81 5.182-7.688 3.815-12.015l-6.16 4.58 2.343 7.45-6.157-4.597-6.158 4.58 2.358-7.433-6.188-4.55 7.63-.045L12.008 0l2.356 7.404 7.615.044z"/>',
  },
  // GitLab: the tanuki silhouette (CC0 Simple Icons) in GitLab orange.
  gitlab: {
    viewBox: "0 0 24 24",
    inner:
      '<path fill="#FC6D26" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/>',
  },
  // Keycloak: the keyhole-in-faceted-circle mark (CC0 Simple Icons), mono so it themes (its silhouette is
  // neutral; rendered in the tile's text colour it reads clearly on both skins).
  keycloak: {
    viewBox: "0 0 24 24",
    inner:
      '<path fill="currentColor" d="m18.742 1.182-12.493.002C4.155 4.784 2.079 8.393 0 12.002c2.071 3.612 4.162 7.214 6.252 10.816l12.49-.004 3.089-5.404h2.158v-.002H24L23.996 6.59h-2.168zM8.327 4.792h2.081l1.04 1.8-3.12 5.413 3.117 5.403-1.035 1.81H8.327a2047.566 2047.566 0 0 0-4.168-7.204C5.547 9.606 6.937 7.2 8.327 4.792Zm6.241 0 2.086.003c1.393 2.405 2.78 4.813 4.166 7.222l-4.167 7.2h-2.08c-.382-.562-1.038-1.808-1.038-1.808l3.123-5.405-3.124-5.413z"/>',
  },
  // JumpCloud: no Simple Icons entry and no simply reproducible mark, so a clean cloud-with-a-jump-arrow in
  // JumpCloud green stands in (the name is the mnemonic), captioned by the visible label.
  jumpcloud: {
    viewBox: "0 0 24 24",
    inner:
      '<path fill="#18C29A" d="M7 19a4.25 4.25 0 0 1-.78-8.43 5.25 5.25 0 0 1 10.06-1.4A4 4 0 0 1 18.25 19z"/>' +
      '<path fill="#ffffff" d="M12 8.4l3 3.2h-1.85v3.6h-2.3v-3.6H9z"/>',
  },
  // Generic SAML 2.0: no vendor logo, so the "nice icon" is a signed-assertion shield with a tick, in the
  // trust teal that the rest of the console uses for the verified/signed posture.
  saml: {
    viewBox: "0 0 24 24",
    inner:
      '<path fill="#14a596" d="M12 1.6 3.6 4.9v6.3c0 5.05 3.43 8.74 8.4 10.4 4.97-1.66 8.4-5.35 8.4-10.4V4.9z"/>' +
      '<path fill="#ffffff" d="m10.7 14.66-2.49-2.49-1.46 1.46 3.95 3.95 6.7-6.7-1.46-1.46z"/>',
  },
  // Generic OIDC: the OpenID mark (CC0 Simple Icons) in OpenID orange.
  oidc: {
    viewBox: "0 0 24 24",
    inner:
      '<path fill="#F78C40" d="M14.54.889l-3.63 1.773v18.17c-4.15-.52-7.27-2.78-7.27-5.5 0-2.58 2.8-4.75 6.63-5.41v-2.31C4.42 8.322 0 11.502 0 15.332c0 3.96 4.74 7.24 10.91 7.78l3.63-1.71V.888m.64 6.724v2.31c1.43.25 2.71.7 3.76 1.31l-1.97 1.11 7.03 1.53-.5-5.21-1.87 1.06c-1.74-1.06-3.96-1.81-6.45-2.11z"/>',
  },
  // Generic OAuth2: no strong standalone logo, so a key (the universal "authorisation" mnemonic) in a steel
  // blue, distinct from Okta's brighter blue.
  oauth: {
    viewBox: "0 0 24 24",
    inner:
      '<circle cx="8.5" cy="12" r="4.3" fill="none" stroke="#4C7AA8" stroke-width="2.2"/>' +
      '<path d="M12.4 12H21M18.7 12v3M21 12v3.4" fill="none" stroke="#4C7AA8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
};

// The neutral fallback mark for a future engine preset the console does not recognise (providerKey -> null):
// a calm globe so the tile still renders rather than showing an empty square.
const FALLBACK_MARK: Mark = {
  viewBox: "0 0 24 24",
  inner:
    '<g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21M12 3C9.5 5.5 8.2 8.7 8.2 12S9.5 18.5 12 21"/></g>',
};

// providerLogo returns the brand mark for a key (or the neutral fallback for an unknown key), sized to the
// grid tile. A standalone exported builder so the tile grid and the connection-management header can both
// render the same mark.
export function providerLogo(key: ProviderKey | null, size = 30): SVGSVGElement {
  // The drift record is NOT made here. It is made at the RESOLUTION site (resolveId), because by the time a key
  // reaches this function the unknown preset has already become `null` and is indistinguishable from a connection
  // that never named a preset. MARKS is total over ProviderKey, so a "this build has no mark for that key" test
  // here is unsatisfiable: it was the branch that would have looked closed while recording nothing.
  const mark = (key && MARKS[key]) || FALLBACK_MARK;
  return brandSvg(mark.inner, mark.viewBox, size);
}
