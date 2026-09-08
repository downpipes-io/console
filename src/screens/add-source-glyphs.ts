// Screen-local presentation helpers for the "attach a source manually" screen (add-source.ts):
// the trusted in-repo SVG glyphs for each store/token type, the per-type one-line summaries, and
// the attach-error message trimmer. These are pure and stateless (no DOM, no engine), pulled out
// of the screen so the picker chrome stays small. Each icon is an in-repo constant, never server
// data, so svgIcon's innerHTML over it is safe (dom.ts), exactly as on the Sources screen.
//
// House: Australian English, no em dashes, precise claims.

import type { StoreType } from "../lib/add-source.ts";
import type { TokenSourceType } from "../lib/token-source.ts";
import { ICON_STREAM, ICON_IMAGES, ICON_ARTIFACTS } from "./sources-downpipes/helpers.ts";
import { refusalText } from "../components/error-view.ts";

// errMsg is the attach refusal on the manual add-source screen. It exists so this surface and the
// account catalogue read IDENTICALLY, which is the whole reason it was written beside its twin, and
// it is what makes a third private copy of the transform the wrong shape for it: when
// screens/sources/shared.ts moved to the reviewed rule, a copy left here would have made the two
// attach surfaces disagree about the same refusal.
//
// So it is the same rule, refusalText (components/error-view.ts): the engine's own sentence when the
// throw carries one, the reviewed sentence for the classified kind when it does not. The old
// verb-stripping regex took the verb and left the status ("...Read scopes.: 400"), and on a 403 that
// the transport had already classified it left the console's own classifier token standing alone
// beside the Attach button.
export function errMsg(err: unknown): string {
  return refusalText(err);
}

// ---- screen-local trusted SVG glyphs (the store-type icons, matching the sources screen). Each
// is an in-repo constant, never server data, so svgIcon's innerHTML over it is safe (dom.ts) ----
const ICON_KV = '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>';
const ICON_R2 = '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>';
const ICON_D1 = '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>';
const ICON_SECRETS = '<circle cx="8" cy="8" r="4"/><path d="m11 11 8 8"/><path d="m16 16 3-3"/>';
// cf-config (Cloudflare configuration), a gear; workers, angle brackets (code). These two token
// glyphs are defined locally; cf-config and workers match their wizard glyphs
// (sources-downpipes/helpers.ts). The stream, images and artifacts glyphs are imported from that
// same wizard helper so every token type shows its own glyph here too. Each is an in-repo
// constant, never server data (svgIcon-safe).
const ICON_CFCONFIG = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
const ICON_WORKERS = '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>';

export function storeIcon(t: StoreType): string {
  return t === "kv" ? ICON_KV : t === "r2" ? ICON_R2 : t === "d1" ? ICON_D1 : ICON_SECRETS;
}

// tokenSourceIcon returns the in-repo glyph for a token source. Each of the five token types has its
// own glyph; cf-config and workers are defined locally, stream, images and artifacts are shared with
// the wizard helper. The switch is exhaustive, so a new TokenSourceType member fails the build here.
export function tokenSourceIcon(t: TokenSourceType): string {
  switch (t) {
    case "cf-config": return ICON_CFCONFIG;
    case "workers": return ICON_WORKERS;
    case "stream": return ICON_STREAM;
    case "images": return ICON_IMAGES;
    case "artifacts": return ICON_ARTIFACTS;
  }
}

// A short one-line summary per store type for the picker (what the operator is wiring).
export function storeSummary(t: StoreType): string {
  switch (t) {
    case "kv": return "Back up a KV namespace. You will need its namespace id.";
    case "r2": return "Back up an R2 bucket. You will need its bucket name.";
    case "d1": return "Back up a D1 database. You will need its database name and id.";
    case "secrets": return "Back up a named Secrets Store secret. You will need its store id and secret name.";
  }
}
