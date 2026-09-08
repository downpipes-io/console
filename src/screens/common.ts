// Shared scaffolding for the screen modules, and the SCREEN-DESCRIPTOR CONTRACT.
// Each IA screen is a self-owned module that exports one
// descriptor: { route, title, render(ctx), actions }. Making the descriptor explicit
// is what lets a screen own its own route(s) and its own action set, so the
// integrator (and the app.ts router wiring) registers screens FROM their descriptors
// instead of hand-maintaining a parallel route list and a parallel action registry.
//
// This module documents the ScreenDescriptor contract for every screen, so its high
// comment density is an intentional and architecturally justified deviation from the
// 25% review threshold.
//
// The shape:
//   - route:   the route pattern(s) this screen owns (a single "/audit", or several
//              like ["/restore", "/restore/approvals", "/restore/:runId"]). The
//              integrator binds each pattern to this screen's render via screenRoutes().
//   - title:   the short context-bar title (shell.setTitle).
//   - measure: the content measure (prose for forms/reading, wide for dense tables and
//              dashboards). Drives shell.setMain's width cap.
//   - render(ctx): builds the screen node from the render context (the matched route
//              plus the live engine + caller + navigate). ctx is a SUPERSET of the
//              router's RouteMatch, so a screen may type its parameter as either the
//              full ScreenContext (to read engine/caller) or just RouteMatch (params /
//              pattern only); both satisfy this contract.
//   - actions: the screen-owned commands that feed the shared action registry / command
//              palette (shell/registry.ts), each gated by role + engine state. A screen
//              with no palette-surfaced action exports []. Dangerous actions carry
//              kind:"flow" so the consumer opens the safe review-then-confirm flow.
//
// The screens compose the primitives in components/ and read the engine via api.ts;
// the trust chip reads the REAL verdict, never a hardcoded green (F7).

import { type Caller, type EngineClient, hasRole, type Role } from "../api.ts";
import { noteGateComputedBlind } from "../lib/client-diag/identity-gate.ts";
import { h, scrollToSafe, svgIcon } from "../lib/dom.ts";
import { ICON_CHEVRON_LEFT } from "../lib/icons.ts";
import { type Capability, callerCan, OWNER_RESERVED_CAPABILITIES } from "../lib/identity.ts";
import { blindGateRemedy } from "../lib/identity-remedy.ts";
import { backTo, caller, navigate } from "../lib/nav.ts";
import type { RouteMatch } from "../lib/router.ts";
import { getEngine } from "../lib/store.ts";
import { capabilityPhrase } from "./capability-copy.ts";

// ScreenContext is the render context a screen's render(ctx) receives. It EXTENDS the
// router's RouteMatch (so pattern / params / query / path are all present) and adds the
// live app handles a screen needs without taking the whole store as a dependency: the
// connected engine client (or null), the resolved caller (or null while whoami is
// pending), and the navigate bridge. Because it is a superset of RouteMatch, an
// existing screen that types its parameter as RouteMatch stays assignable to this
// contract (method-parameter bivariance), so adopting the richer context is opt-in per
// screen and never a forced rewrite.
export interface ScreenContext extends RouteMatch {
  // The connected engine client, or null when no engine is connected. A screen that
  // needs the engine should still call requireEngine() (which redirects to onboarding
  // when absent); this field is the same client, surfaced on the context for
  // convenience and testability.
  engine: EngineClient | null;
  // The resolved caller (identity + role) for the client-side gate mirror, or null
  // while whoami (D1) is pending. The engine is the enforcement point; this is UX only.
  caller: Caller | null;
  // The app navigate bridge (lib/nav.ts), so a screen can route without importing the
  // router directly (no cycle).
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

// ScreenActionKind mirrors the action registry's CommandKind (shell/registry.ts): a
// benign navigation, a benign inline action, or a dangerous flow that must open the
// safe review-then-confirm path rather than executing directly.
export type ScreenActionKind = "navigate" | "action" | "flow";

// ScreenAction is one screen-owned command. It is the registry-feedable shape: an id,
// a human title, the palette group, the kind, search keywords, the dispatch target
// (a route for "navigate", or an action id the consumer dispatches for "action" /
// "flow"), an optional go-to chord, and an optional `when` gate over the caller's role
// and engine state. The gate MIRRORS the engine's per-route minimum; it is never the
// control (the engine enforces server-side). A command the role cannot run is not
// shown, so the palette never lists an action that 403s.
export interface ScreenAction {
  id: string;
  title: string;
  group: "Navigation" | "Downpipes" | "Runs" | "Actions";
  kind: ScreenActionKind;
  keywords: string[];
  target: string;
  shortcut?: string;
  when?: (ctx: { caller: Caller | null; engine: { ready?: boolean; downpipeCount?: number; updateAvailable?: boolean; connected?: boolean } }) => boolean;
}

// Screen is the explicit descriptor every screen module exports.
// It is the single contract the router wiring and the command registry both read, so a
// screen is genuinely self-owned: it declares the route(s) it serves and the actions it
// contributes, and the integrator wires it without a parallel hand-maintained list.
export interface Screen {
  // The route pattern(s) this screen owns; a single pattern or several (e.g. a list +
  // its detail/sub routes). screenRoutes() binds each to render().
  route: string | string[];
  // The short context-bar title.
  title: string;
  // The content measure cap (prose | wide | full). "full" = no cap, for a screen that owns its
  // own full-bleed layout (onboarding renders its own header/rail/content).
  measure: "prose" | "wide" | "full";
  // Build the screen node from the render context (the matched route + engine + caller
  // + navigate). May be typed by the screen as ScreenContext or RouteMatch.
  render(ctx: ScreenContext): HTMLElement;
  // The screen-owned commands for the shared action registry / palette. Empty when the
  // screen surfaces none.
  actions: ScreenAction[];
}

// defineScreen is the tiny identity helper a screen module uses to declare its
// descriptor with full type-checking at the definition site (so a missing route or a
// mistyped action is caught in the screen's own file, not at the wiring). It returns
// the descriptor unchanged; it exists only for inference + the explicit contract.
export function defineScreen(screen: Screen): Screen {
  return screen;
}

// routesOf normalises a descriptor's route (string | string[]) to a list, so the
// wiring iterates one shape.
export function routesOf(screen: Screen): string[] {
  return Array.isArray(screen.route) ? screen.route : [screen.route];
}

// screenRoutes is the integrator's wiring helper: given the screen descriptors and a
// bind callback (pattern -> render), it registers EVERY pattern each screen owns,
// straight from the descriptors. This is the single place route registration happens,
// derived from the self-owned screens, so the router table and the screens never drift.
// app.ts passes a bind that adapts render(ctx) to the router's RouteHandler (building
// the ScreenContext from the match + the live engine/caller). A screen listed twice for
// the same pattern is a programming error the caller can assert on; this helper stays
// minimal and just forwards.
export function screenRoutes(screens: Screen[], bind: (pattern: string, screen: Screen) => void): void {
  for (const screen of screens) {
    for (const pattern of routesOf(screen)) bind(pattern, screen);
  }
}

// allScreenActions flattens the descriptors' actions into the one list the command
// palette / registry consumes, so the palette is assembled FROM the self-owned screens
// rather than a separate hand-kept array. Each screen carries its own actions via its
// descriptor; this function is the source of truth for the assembled palette.
// Deduplicated by id (first wins) so a screen and the baseline cannot register the same
// command twice.
export function allScreenActions(screens: Screen[]): ScreenAction[] {
  const seen = new Set<string>();
  const out: ScreenAction[] = [];
  for (const screen of screens) {
    for (const action of screen.actions) {
      if (seen.has(action.id)) continue;
      seen.add(action.id);
      out.push(action);
    }
  }
  return out;
}

// makeScreenContext builds the render context for a resolved route from the router match
// and the live app state. The integrator (app.ts) calls this inside its bind adapter so
// every screen receives the same, consistent context. Kept here next to the contract so
// the one context vocabulary is shared. The engine + caller are read from the store via
// the passed-in getters to avoid a static import cycle through app wiring.
export function makeScreenContext(
  match: RouteMatch,
  deps: { engine: EngineClient | null; caller: Caller | null; navigate: (to: string, opts?: { replace?: boolean }) => void },
): ScreenContext {
  return { ...match, engine: deps.engine, caller: deps.caller, navigate: deps.navigate };
}

// pageHeader builds the standard page header (one h1 per view + optional description
// and an optional actions slot on the right). The optional crumb renders ONE quiet,
// referrer-aware "Back to <label>" link above the h1 (the navigation design): a child
// page declares its structural parent as the fallback, and backTo() returns the
// operator to where they actually came from when that is known. Top-level screens omit
// it (no crumb renders), so the calm title strip is unchanged for the 20 screens that
// are not sub-pages. The context bar stays title-less (CALM-05); orientation lives here
// in the title strip, where section 7a already sanctions it.
export function pageHeader(title: string, desc?: string, actions?: Node, crumb?: { label: string; to: string }): HTMLElement {
  const head = h("div", { class: "page-header" });
  if (crumb) {
    head.appendChild(
      h(
        "div",
        { class: "page-header__crumb" },
        h(
          "button",
          { "data-dp": "common.button.back-to", class: "page-header__back", type: "button", on: { click: () => backTo(crumb.to) } },
          svgIcon(ICON_CHEVRON_LEFT, { size: 14 }),
          `Back to ${crumb.label}`,
        ),
      ),
    );
  }
  const top = h("div", { class: "page-header__row" }, h("h1", { class: "page-header__title" }, title));
  if (actions) {
    top.appendChild(h("div", { class: "page-header__actions" }, actions));
  }
  head.appendChild(top);
  if (desc) head.appendChild(h("p", { class: "page-header__desc measure" }, desc));
  return head;
}

// screenScaffold composes the header + body for a screen. The scaffold carries the
// screen rhythm (CALM-08): major blocks separate with section-scale gaps via
// .screen-stack, so groups form from space rather than boxes.
export function screenScaffold(header: HTMLElement, ...body: Node[]): HTMLElement {
  const wrap = h("div", { class: "screen-stack" }, header);
  for (const b of body) wrap.appendChild(b);
  return wrap;
}

// lazyDisclosure (CALM-01): a collapsed section whose body mounts on FIRST open, so
// demoted content costs nothing (no render, no fetch) until asked for. The summary
// carries the section's real heading (summary permits one heading element), so
// heading navigation and the document outline survive the demotion.
export function lazyDisclosure(
  title: string,
  build: () => Node,
  opts: { tone?: "danger"; open?: boolean } = {},
): HTMLElement {
  const body = h("div", { class: "disclosure__body" });
  let mounted = false;
  const details = h(
    "details",
    { class: `disclosure${opts.tone === "danger" ? " disclosure--danger" : ""}`, ...(opts.open ? { open: true } : {}) },
    h("summary", h("h2", { class: "disclosure__heading" }, title)),
    body,
  ) as HTMLDetailsElement;
  const mount = (): void => {
    if (mounted || !details.open) return;
    mounted = true;
    body.appendChild(build());
  };
  details.addEventListener("toggle", mount);
  if (opts.open) mount();
  return details;
}

// collapsedSection: lazyDisclosure's eager sibling, the body renders NOW (static
// reference content stays find-in-page-able and programmatic hand-offs can open it
// synchronously) but presents collapsed, so only the visual weight is deferred.
// `open` presents it expanded from the start (for a control owners must be able to find,
// where the collapse would hide it rather than just demote its weight).
export function collapsedSection(title: string, body: Node, opts: { tone?: "danger"; open?: boolean } = {}): HTMLDetailsElement {
  return h(
    "details",
    { class: `disclosure${opts.tone === "danger" ? " disclosure--danger" : ""}`, ...(opts.open ? { open: true } : {}) },
    h("summary", h("h2", { class: "disclosure__heading" }, title)),
    h("div", { class: "disclosure__body" }, body),
  );
}

// openDisclosureByTitle is the header add-action's hand-off (the add-action consistency
// fix): it finds the disclosure whose summary heading matches `title` inside `scope`,
// opens it, scrolls it into view and focuses its first field, so the disclosure stays
// the one landing surface while the page header still carries a primary add action.
// When no such disclosure exists (the first-run state where the form IS the screen),
// it scrolls the scope itself and focuses the first field there instead. Some
// disclosure bodies mount asynchronously on first open (the destination form loads its
// context first), so the focus retries briefly rather than assuming a synchronous mount.
//
// title ALSO accepts an ordered list of candidate titles, for a header button that must
// lead somewhere true across states that render DIFFERENTLY TITLED disclosures for what
// is, from the header, the same "add" intent. The Destinations screen is the case this
// was built for (DEST-ADD-BUTTON-DEPLOY-STATE): its deploy-bound state (a
// destination bound at deploy time, no console record yet) renders the add surface as a
// "Replace from the console" disclosure rather than an "Add a destination" one, so a
// caller that only ever asked for the multi-destination state's title found nothing,
// fell through to the scope-scroll branch, and the button read as though it did nothing.
// The first title in the list whose disclosure exists wins; none matching falls through
// to the scope itself, same as the single-title case always has.
export function openDisclosureByTitle(scope: HTMLElement, title: string | readonly string[]): void {
  const titles = typeof title === "string" ? [title] : title;
  const all = [...scope.querySelectorAll("details")];
  const details = titles
    .map((t) => all.find((d) => (d.querySelector("summary")?.textContent ?? "").trim() === t))
    .find((d): d is HTMLDetailsElement => d !== undefined);
  if (details) details.open = true;
  const target: HTMLElement = details ?? scope;
  scrollToSafe(target, { behavior: "smooth", block: "start" });
  focusFirstField(target);
}

// focusFirstField focuses the first enabled form control (or button) inside scope,
// retrying on a short bounded timer for a body that mounts asynchronously. Bails when
// the scope leaves the DOM (the operator navigated away before the mount finished).
function focusFirstField(scope: HTMLElement, attempt = 0): void {
  if (!scope.isConnected) return;
  const field = scope.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
  );
  if (field) {
    field.focus();
    return;
  }
  if (attempt >= 20) return;
  window.setTimeout(() => focusFirstField(scope, attempt + 1), 150);
}

// requireEngine returns the connected engine client, or routes to onboarding and
// returns null (a screen that needs the engine cannot render without it). The full
// unconfigured-engine check (status.ready) is the onboarding screen's; this is the
// no-engine-connected-at-all guard the foundation already applies on "/".
export function requireEngine(): EngineClient | null {
  const engine = getEngine();
  if (!engine) {
    navigate("/onboarding/connect", { replace: true });
    return null;
  }
  return engine;
}

// canDo mirrors the engine's per-route minimum role for the CLIENT gate (the engine
// is the enforcement point; this only decides whether to show/enable a control). A
// null caller (whoami pending) is treated conservatively as not-yet-known: the
// control renders disabled-with-reason rather than enabled, so the console never
// shows an action it cannot yet attribute a role to.
//
// The null branch WITNESSES (noteGateComputedBlind), and that is the R-DIV-1 residue fix. canDo and
// canCap are the console's PRIMARY gates, and until now they were the only fail-closed-on-null gates
// that stayed silent: the witness was wired into four local copies of this same predicate
// (security-centre, credentials, notifications, the role builder) and into neither original. Two
// consequences, both live rather than cosmetic. The support pack could not carry an
// identity-stale-gate row naming any screen that gates through here, restore included, so a raced
// Owner and a genuine viewer produced byte-identical evidence on exactly the screens that matter
// most. And currentScreenGatedBlind() reads this witness to set app.ts's forceForBlindGate, so the
// same-identity re-render could never fire for those screens and a late blind gate stayed stuck.
export function canDo(atLeast: Role): boolean {
  const c = caller();
  if (!c) {
    noteGateComputedBlind();
    return false;
  }
  return hasRole(c.role, atLeast);
}

// gateReason returns the inline disabled-with-reason copy for a role-gated control
// ("disabled-with-reason, not hidden-then-403"). It states the
// required role plainly so a gate reads as governed, never a mystery failure.
// It names the caller's CUSTOM role when they hold one, for the same reason capGateReason already
// does: a caller on a named custom role carries role="viewer" as the engine's ladder floor (see
// canCap), so reading c.role told a customer on a "Recovery lead" role that they are a Viewer. That
// is a false statement about their own identity, printed in the sentence that is supposed to explain
// why they are stuck, and it appeared on four setup screens. The two generators now agree.
export function gateReason(atLeast: Role): string {
  const c = caller();
  if (!c) return `Requires the ${titleRole(atLeast)} role. ${blindGateRemedy()}`;
  const held = c.customRole ? `you hold the ${c.customRole.label} role` : `you are ${titleRole(c.role)}`;
  return `Requires the ${titleRole(atLeast)} role; ${held}. ${GRANT_REMEDY}`;
}

// GRANT_REMEDY is the third sentence every authorisation refusal in this console was missing. The two
// generators above and below name WHAT is needed and WHY it is refused, and then stopped, so a customer
// who reads "Requires the Owner role; you are Viewer" is told nothing about how to stop being stuck. A
// refusal a customer cannot act on is a defect even when the refusal itself is correct.
//
// It names the OWNER only, deliberately, and that is a precision decision rather than an omission. Roles
// are managed by a holder of access.policy, which is the Owner AND the Access admin, so naming both would
// be true of the screen. It would not be true of the grant: the engine applies requireGrantWithinAuthority
// to built-in roles too (scheduler-do-rbac-mutations.ts), so an Access admin can only confer a role whose
// capabilities it already holds and cannot grant Owner or Operator at all. An Owner holds everything and
// can therefore always do what this sentence says. Under-naming who can help is recoverable; naming
// somebody who will then be refused is not.
const GRANT_REMEDY = "An Owner can change this on the Access screen.";

// canCap is the CAPABILITY-model companion to canDo: it mirrors the engine's per-route capability gate
// for the CLIENT gate (the engine is the enforcement point; this only decides whether to show/enable a
// control). New affordances on the two narrow roles (restore-operator, access-admin) and the
// custom-role surfaces gate by capability, not by the cumulative ladder, so a control the role's
// capability set does not hold is never offered (e.g. the role builder is gated by access.policy, held
// by Owner AND access-admin). A null caller (whoami pending) fails closed, and WITNESSES: see canDo
// above for why the silence was the defect, and identity-gate.ts for what the row does and does not say.
export function canCap(capability: Capability): boolean {
  const c = caller();
  if (!c) {
    noteGateComputedBlind();
    return false;
  }
  // A caller on a NAMED custom role carries role="viewer" (the engine's floor) but holds real authority
  // in its capability set, so gate on the EFFECTIVE set via callerCan (the client mirror of the engine's
  // callerCan), never can(c.role, ...) which would floor a custom-role holder to viewer and hide every
  // control their custom role actually grants. For the six built-in roles customRole is absent and
  // callerCan(role, cap, null) === can(role, cap) exactly, so this changes nothing for them.
  return callerCan(c.role, capability, c.customRole ?? null);
}

// callerIsUnresolved answers the question a boolean gate cannot: was this control refused, or has nobody
// asked yet. canDo and canCap above both return false in those two situations, correctly, because a gate
// must fail closed. But a SURFACE that renders "false" as a settled refusal states something it has not
// established, and that is what the Integrations grid printed on all 40 tiles at once when an owner opened
// the screen: "Owner", meaning "you are not the owner", to the owner. Every other gated screen already keeps
// the two apart in its COPY (gateReason and capGateReason below both branch on a null caller and say the
// engine has not reported the role); this is the same distinction for a surface that renders a CONTROL STATE
// rather than a sentence, so the two cannot drift.
//
// It witnesses in the null branch, exactly as canDo and canCap do. The witness is a Set keyed by screen
// (client-diag/identity-gate.ts), so a screen that also called a real gate is recorded once, not twice, and
// the identity-stale-gate row this screen already emitted is unchanged.
//
// It lifts no gate and enables nothing: a caller it reports unresolved for is a caller canDo and canCap have
// already refused.
export function callerIsUnresolved(): boolean {
  const c = caller();
  if (!c) {
    noteGateComputedBlind();
    return true;
  }
  return false;
}

// capGateReason is the disabled-with-reason copy for a capability-gated control, the canCap companion
// to gateReason. It names the PERMISSION in customer language, never the raw internal capability id
// the id ("restore.apply", "downpipe.write") is an engine-side symbol, not a phrase a customer
// would recognise, so it is translated via capabilityPhrase (screens/capability-copy.ts) before it ever
// reaches the sentence. capabilityPhrase is total over the closed Capability union (compiler-enforced,
// see capability-copy.ts), so every capability this function is ever called with resolves to a phrase;
// there is no raw-id fallback branch to fall into.
// AN OWNER-RESERVED CAPABILITY GETS A DIFFERENT REMEDY, because GRANT_REMEDY is FALSE for one.
// keys.ceremony and posture.riskaccept are in OWNER_RESERVED_CAPABILITIES: they are held by the owner
// built-in alone, the role builder refuses to put them in a custom role, and the engine mirrors that
// bar. So "An Owner can change this on the Access screen" named an action no Owner can take, on every
// control gated by them: the four Identity providers controls, the licence update apply and rollback,
// and the bulk source re-attach. The console already says the true thing eleven lines apart in another
// module ("Owner-reserved; cannot be delegated", roles-builder/form.ts), and this sentence contradicted
// it. GRANT_REMEDY's own note calls this the unrecoverable half: under-naming who can help is
// survivable, naming somebody who will then be refused is not, and this was the second.
//
// The replacement says what a customer can actually do, which is ask an Owner to perform the action
// rather than to grant them anything.
const OWNER_RESERVED_REMEDY = "It is reserved to the Owner and cannot be granted to another role, so an Owner needs to do this one.";

export function capGateReason(capability: Capability): string {
  const c = caller();
  const remedy = OWNER_RESERVED_CAPABILITIES.has(capability) ? OWNER_RESERVED_REMEDY : GRANT_REMEDY;
  if (!c) return `Requires ${capabilityPhrase(capability)}. ${blindGateRemedy()}`;
  // Name the caller's custom role when they hold one: canCap now resolves authority from the custom
  // role's capability set, so the reason must speak to that role, not the "viewer" ladder floor.
  const held = c.customRole ? `your ${c.customRole.label} role` : `your ${titleRole(c.role)} role`;
  return `Requires ${capabilityPhrase(capability)}; ${held} does not hold it. ${remedy}`;
}

function titleRole(r: Role): string {
  return r.charAt(0).toUpperCase() + r.slice(1);
}

// refuseWithReason: the shared refusal primitive, which now lives in lib/dom.ts beside h(). It moved
// there so components/ can use the SAME implementation: components/detail-drawer.ts
// and sources-downpipes/helpers.ts were each carrying their own copy of the pattern, and a
// components/ file importing this module would be a circular dependency (lint:circular). It is
// re-exported here so every screen that already imports it from ./common.ts is unchanged. The
// rationale, and the browser measurements behind the aria-describedby form, live with the
// implementation.
export { refuseWithReason } from "../lib/dom.ts";

// filteredEmpty (the filtered-to-nothing empty state, sibling to trueEmpty above) was removed
// : dead since authoring, no caller in the console's history. The job it was built for is
// already done, generically, by components/data-table-render.ts's filteredEmptyNode, which every
// screen built on the shared dataTable() component (including sources-downpipes, the table this
// helper cites as trueEmpty's sibling) gets for free; the one screen with its own server-side filter
// (access-security/audit-events.ts) hand-rolls its own emptyState() call because its filter has no
// single "query" string to interpolate, which this helper's signature required. Wiring it in would
// have meant a second, divergent filtered-empty implementation beside the one already live.

// pendingEngineNote renders the honest "this surface is design-complete, pending the
// engine dependency" panel for D1/D2/D3/D4 surfaces that the engine does not yet
// back, so the copy is accurate and never fakes a capability (DESIGN-REVIEW F5). The
// gate UX is still shown; this states enforcement is pending.
export function pendingEngineNote(opts: { what: string; dependsOn: string; interim?: string }): HTMLElement {
  // The calm form (CALM-04): standing information renders as ONE quiet line, not a
  // tinted panel, the tinted banner family stays reserved for action-needed-now.
  // The interim detail sits behind a disclosure rather than stacking paragraphs.
  const body = h("div");
  body.appendChild(h("p", `${opts.what} Pending engine support: ${opts.dependsOn}. The console renders the surface; the engine is the enforcement point.`));
  if (opts.interim) {
    body.appendChild(
      h(
        "details",
        { class: "disclosure", style: "margin-top:var(--space-1)" },
        h("summary", "In the interim"),
        h("p", { class: "disclosure__body" }, opts.interim),
      ),
    );
  }
  return h("div", { class: "note-quiet measure" }, body);
}
