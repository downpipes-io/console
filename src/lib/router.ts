// A small History-API router with the product's flat route table. Zero dependency. It maps a
// path pattern (with :params) to a handler, parses the query string, supports the
// back button, and exposes navigate() for in-app links. Clean URLs work because
// the console Worker serves an SPA fallback (any 404 -> index.html); a hash fallback is kept for
// the file:// / no-server case.
//
// What the router does NOT do: it never enforces auth or roles. The edge + engine
// enforce auth; the screen and the action registry gate by Caller.role and engine state. The
// router only resolves which screen renders.

export interface RouteMatch {
  // The matched path pattern (e.g. "/downpipes/:id"), useful for highlighting nav.
  pattern: string;
  // Named path params (e.g. { id: "01H..." }), already URL-decoded.
  params: Record<string, string>;
  // The query string parsed into a URLSearchParams. For repeated keys, .get() returns
  // the first value (standard URLSearchParams behaviour).
  query: URLSearchParams;
  // The full current path (no query, no hash).
  path: string;
}

export type RouteHandler = (match: RouteMatch) => void;

interface CompiledRoute {
  pattern: string;
  // The segments of the pattern; a segment starting ":" is a param.
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: CompiledRoute[] = [];
  private fallback: RouteHandler | null = null;
  private started = false;
  // useHash is true only when there is no real path routing available (file://).
  private readonly useHash: boolean;
  private onChange: ((m: RouteMatch) => void) | null = null;

  constructor() {
    this.useHash = typeof location !== "undefined" && location.protocol === "file:";
  }

  // add registers a route. Patterns are "/", "/downpipes", "/downpipes/:id", etc.
  add(pattern: string, handler: RouteHandler): this {
    this.routes.push({ pattern, segments: splitPath(pattern), handler });
    return this;
  }

  // notFound registers the handler for an unmatched path.
  notFound(handler: RouteHandler): this {
    this.fallback = handler;
    return this;
  }

  // afterEach registers a callback run on every successful resolution (after the
  // handler), e.g. to update the active nav item and the document title. Single-slot:
  // only the most recently registered callback is kept; a second call replaces the first.
  afterEach(cb: (m: RouteMatch) => void): this {
    this.onChange = cb;
    return this;
  }

  // start begins listening and resolves the current URL once.
  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener("popstate", () => this.resolve());
    // Re-resolve on a hash change in BOTH modes: hash mode routes on the hash, and path mode honours an
    // in-app hash deep link (the emailed #/register?invite=... invite link), so a hash change must re-resolve
    // there too. A normal in-app navigation in path mode does not touch the hash, so this never fires
    // spuriously on it.
    window.addEventListener("hashchange", () => this.resolve());
    this.resolve();
  }

  // current returns the current path (from the pathname, or the hash in hash mode).
  current(): { path: string; query: URLSearchParams } {
    if (this.useHash) {
      return parseHashRoute(location.hash);
    }
    // Path (clean-URL) mode is the norm, but an EMAILED deep link uses the hash form
    // (${CONSOLE_ORIGIN}/#/register?invite=<token>) so the link works no matter what the static host
    // serves at that path: when the pathname is the root and a hash names an in-app route ("#/..."), parse
    // the path + query from the hash instead, so #/register?invite=... resolves to the /register route (and
    // its ?invite= reaches the screen) rather than falling through to "/". A non-root pathname, or a root
    // pathname with no in-app hash, is unaffected and reads the pathname + search exactly as before.
    if (normalisePath(location.pathname) === "/" && isInAppHash(location.hash)) {
      return parseHashRoute(location.hash);
    }
    return { path: normalisePath(location.pathname), query: new URLSearchParams(location.search) };
  }

  // navigate pushes a new URL and resolves it. `replace` swaps the history entry
  // instead of pushing (used for redirects, e.g. unconfigured -> onboarding).
  navigate(to: string, opts: { replace?: boolean } = {}): void {
    const target = this.useHash ? `#${to}` : to;
    if (opts.replace) history.replaceState({}, "", target);
    else history.pushState({}, "", target);
    this.resolve();
  }

  // resolve matches the current URL against the table and runs the handler.
  private resolve(): void {
    const { path, query } = this.current();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, splitPath(path));
      if (params) {
        const match: RouteMatch = { pattern: route.pattern, params, query, path };
        route.handler(match);
        if (this.onChange) this.onChange(match);
        return;
      }
    }
    if (this.fallback) {
      const match: RouteMatch = { pattern: "*", params: {}, query, path };
      this.fallback(match);
      if (this.onChange) this.onChange(match);
    }
  }
}

// ---- hash deep-link parsing -------------------------------------------------

// isInAppHash reports whether a location.hash names an in-app route ("#/..."), as opposed to an empty hash
// or a plain fragment anchor ("#section"). Only a hash whose path part starts with "/" is treated as a
// route, so an ordinary in-page anchor is never mistaken for one.
function isInAppHash(hash: string): boolean {
  const raw = hash.replace(/^#/, "");
  return raw.startsWith("/");
}

// parseHashRoute splits a location.hash ("#/register?invite=X") into the same { path, query } shape
// current() returns for the pathname, so hash mode and an in-app hash deep link in path mode share one
// parser. An empty hash yields the root with no query.
function parseHashRoute(hash: string): { path: string; query: URLSearchParams } {
  const raw = hash.replace(/^#/, "") || "/";
  const [p, q] = raw.split("?");
  return { path: normalisePath(p || "/"), query: new URLSearchParams(q || "") };
}

// ---- pattern matching -------------------------------------------------------

function normalisePath(p: string): string {
  if (!p || p === "") return "/";
  // Strip a trailing slash except for the root.
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

function splitPath(p: string): string[] {
  const norm = normalisePath(p);
  if (norm === "/") return [];
  return norm.replace(/^\//, "").split("/");
}

// matchSegments returns the param map if the pattern segments match the path
// segments, or null if they do not. Param segments (":name") capture and decode.
function matchSegments(pattern: string[], pathSegs: string[]): Record<string, string> | null {
  if (pattern.length !== pathSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const pat = pattern[i]!;
    const seg = pathSegs[i]!;
    if (pat.startsWith(":")) {
      params[pat.slice(1)] = safeDecode(seg);
    } else if (pat !== seg) {
      return null;
    }
  }
  return params;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// There is deliberately no hand-maintained route table here. There used to be one (a "ROUTES" map this
// file claimed was "the single list so the router, the nav and any deep-link builder reference one
// source"), but the router never bound from it: app.ts binds via screenRoutes(SCREENS, ...), reading each
// screen module's own `route:` field (screens/common.ts), so the map was a second, hand-kept list that
// silently fell 18 patterns behind the 47 the screens actually declare (COV.7). A route's single source
// of truth is its owning screen's `route:` field (and, where a caller outside that screen needs the
// literal, the screen's own exported ROUTE_* constant, e.g. keys/shared.ts ROUTE_KEYS). The FULL derived
// list (for anything that genuinely needs to enumerate every bound pattern, e.g. a coverage gate) lives
// at lib/app-registry.ts's ROUTES export, computed FROM the screens rather than typed out beside them, so
// it cannot drift the way this one did. scripts/route-table-gate.mjs asserts the two stay in step.
