// The bespoke inline-SVG icon set. Each value is the inner
// markup of a 24px-grid icon, drawn with currentColor and a 1.5px stroke by the
// svgIcon() wrapper in dom.ts, so icons theme for free and add no network
// request. No icon font, no icon library (supply chain + the brief). Only the
// glyphs the console needs; add one when a real surface needs it.
//
// House rule: the BRAND MARK is locked and used everywhere (one mark, DESIGN-REVIEW
// F-list). It lives here as the single source so it cannot drift.

// ---- Navigation glyphs ------------------------------------------------------
export const ICON_OVERVIEW =
  '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>';

export const ICON_MAP =
  // a node-and-edge diagram: sources on the left, destination on the right
  '<circle cx="5" cy="8" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 8h4l5 4"/><path d="M7 16h4l5-4"/>';

export const ICON_COSTS =
  // a bar-chart rising left to right (cost projection / estimate)
  '<rect x="3" y="15" width="4" height="6" rx="1"/><rect x="10" y="9" width="4" height="12" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/><path d="M3 3h18"/>';

export const ICON_DOWNPIPES =
  // a route/branch: source splitting toward a destination
  '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 6h4a4 4 0 0 1 4 4v0"/><path d="M8 18h4a4 4 0 0 0 4-4v0"/>';

export const ICON_RUNS =
  // a clock (run history over time)
  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';

export const ICON_RESTORE =
  // rotate-ccw (recover/restore)
  '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>';

export const ICON_KEYS =
  '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="m17 6 2 2"/><path d="m14 9 2 2"/>';

export const ICON_ACCESS =
  // shield (access / Zero Trust)
  '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/>';

export const ICON_ROLES =
  // users (members / roles)
  '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="8" r="3"/><path d="M22 19v-1a4 4 0 0 0-3-3.85"/><path d="M16 5.15A4 4 0 0 1 16 13"/>';

export const ICON_AUDIT =
  // list (the audit log)
  '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>';

export const ICON_SETTINGS =
  // sliders
  '<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h2"/><path d="M10 12h10"/><circle cx="8" cy="12" r="2"/><path d="M4 18h10"/><path d="M18 18h2"/><circle cx="16" cy="18" r="2"/>';

export const ICON_LICENCE =
  // download / update channel
  '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>';

export const ICON_REPORT =
  // a document with ruled lines and a signature tick: the signed reports surface
  '<path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v4h4"/><path d="M8 13h5"/><path d="M8 17h3"/><path d="m13.5 16 1.5 1.5 2.5-2.5"/>';

export const ICON_HOURGLASS =
  // an hourglass: the credential/key expiry tracker (time running down)
  '<path d="M6 3h12"/><path d="M6 21h12"/><path d="M8 3v3.5a4 4 0 0 0 1.6 3.2L12 12l-2.4 2.3A4 4 0 0 0 8 17.5V21"/><path d="M16 3v3.5a4 4 0 0 1-1.6 3.2L12 12l2.4 2.3a4 4 0 0 1 1.6 3.2V21"/>';

// ---- Status glyphs ----------------------------------------------------------
export const ICON_CHECK = '<path d="M20 6 9 17l-5-5"/>';
export const ICON_ALERT = '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>';
export const ICON_X_CIRCLE = '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>';
export const ICON_INFO = '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>';
// a pause glyph (two vertical bars): the disabled status shape, distinct in monochrome.
export const ICON_PAUSE = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
// a question-mark circle: the unknown status shape, distinct in monochrome.
export const ICON_QUESTION = '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3"/><path d="M12 17h.01"/>';

// ---- Action glyphs ----------------------------------------------------------
// Destinations (the archive bucket) and Sources (the discovered catalogue): the two
// new rail items of the setup-first IA. Bucket = the R2-style cylinder; catalogue =
// stacked layers (what your account holds).
export const ICON_DESTINATIONS = '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>';
export const ICON_SOURCES = '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>';
// A small canary in profile (body, beak, eye, wing, tail, feet) for the Canary nav item.
export const ICON_CANARY = '<circle cx="12" cy="11.5" r="5.5"/><path d="M6.5 11.5 3 9.8l1.4 1.7L3 13.2l3.5-1.7"/><path d="M11 9.7h.01"/><path d="M13 13.4c1.8 0 3-1 3.4-2.6"/><path d="M17.2 9.1c1.4-.7 2.6-.6 3.8.4"/><path d="M10 16.8 9 19.5"/><path d="M14 16.8l1 2.7"/>';
export const ICON_PLUS = '<path d="M12 5v14"/><path d="M5 12h14"/>';
export const ICON_TRASH = '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4h6v3"/>';
export const ICON_PLAY = '<path d="M7 4v16l13-8Z"/>';
export const ICON_COPY = '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>';
export const ICON_EYE = '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
export const ICON_EYE_OFF = '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-2.2 3"/><path d="M6.6 6.6A18 18 0 0 0 2 12s4 7 10 7a10.9 10.9 0 0 0 3.9-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';
// Sound on / sound off: the training course's narration toggle. Same stroke language as the set above.
export const ICON_SOUND_ON = '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/>';
export const ICON_SOUND_OFF = '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16.5 9.5 5 5"/><path d="m21.5 9.5-5 5"/>';
export const ICON_EXTERNAL = '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>';
export const ICON_SEARCH = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
export const ICON_CHEVRON_DOWN = '<path d="m6 9 6 6 6-6"/>';
export const ICON_CHEVRON_UP = '<path d="m6 15 6-6 6 6"/>';
export const ICON_CHEVRON_RIGHT = '<path d="m9 6 6 6-6 6"/>';
export const ICON_CHEVRON_LEFT = '<path d="m15 6-6 6 6 6"/>';
export const ICON_CLOSE = '<path d="M6 6 18 18"/><path d="M18 6 6 18"/>';
export const ICON_REFRESH = '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v5h-5"/>';
export const ICON_MENU = '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>';
// An up-arrow in a circle: the context-bar "Update available" chip (shell/chrome.ts).
export const ICON_UPDATE = '<circle cx="12" cy="12" r="9"/><path d="M12 16V8"/><path d="m8.5 11.5 3.5-3.5 3.5 3.5"/>';

// ---- Trust glyphs (no-custody + Access) ------------------
export const ICON_SHIELD_CHECK =
  '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>';
export const ICON_LOCK =
  '<rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';

// ---- Theme glyphs (System / Light / Dark control) ---------------------------
export const ICON_SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/>';
export const ICON_MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>';
export const ICON_MONITOR = '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>';
// Integrations: one source fanning out to two destinations (what forwarding the audit trail and metrics does).
export const ICON_INTEGRATIONS = '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="M8.3 10.9l7.4-3.5"/><path d="M8.3 13.1l7.4 3.5"/>';

// ---- The LOCKED brand mark (the owner's downpipe glyph) ---------------------
// One mark, used everywhere (the rail, the wizard, the signed-out screen). A
// downpipe: a gutter feeding a downspout into a catchment tank. Authored by the
// owner (the repo-root downpipes-mark.svg) on a 512 grid; the ONLY change here is
// the hardcoded slate -> currentColor, so the glyph inherits the surrounding text
// colour and themes for free (the raw slate would be invisible on the dark
// default skin). Rendered by brandMark() in shell/brand.ts, which builds the
// 512-viewBox svg directly (NOT the 24-grid svgIcon, whose fixed viewBox/stroke
// would crop it). The downspout subpath "M352 84V400" is also what the route
// "charge" animates (shell/app-shell.ts). Single source; never draw it inline.
export const BRAND_MARK_VIEWBOX = "0 0 512 512";
export const BRAND_MARK =
  '<g class="dp-mark-body" transform="translate(-11.5 -15)" fill="none" stroke="currentColor" stroke-width="72" stroke-linejoin="round">' +
  '<rect x="160" y="256" width="192" height="192" rx="52"/>' +
  '<path d="M352 84V400" stroke-linecap="butt"/>' +
  '<rect x="293" y="58" width="118" height="26" rx="9" fill="currentColor" stroke="none"/>' +
  '</g>';

// The product wordmark text, kept here so the one spelling/casing is canonical.
export const BRAND_NAME = "downpipes";
