// The browser-storage keys that hold AUTHENTICATED-SESSION data, in one place so the sign-out clear
// (store.ts clearSessionData, ASVS V14.3.1) and the writers agree on exactly which keys exist. Preference
// keys (theme, view mode, motion, the remembered engine URL) are deliberately NOT here: they hold no
// session data and survive a sign-out on purpose.

// DRAFT_PREFIX names every in-progress wizard or selection draft in sessionStorage (lib/draft.ts).
export const DRAFT_PREFIX = "dp-draft:";

// ATTEND_SESSION_KEY persists the active attended-verification session id and sample rate in localStorage
// (screens/restore-flow/attend.ts) so a reopened tab can offer to resume it.
export const ATTEND_SESSION_KEY = "downpipes.attend.session";
