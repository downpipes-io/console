// Typed, textContent-first element creation. This is the SAFE default path the
// redesign uses instead of the old el(html) innerHTML pattern: text content goes in as text nodes,
// never parsed as markup, so a
// server-supplied string (a downpipe name, a run id, an email, a coarse reason,
// an enum) can never inject markup into the in-account console. No framework, no
// dependency; just the DOM.

// The children a node accepts: nested elements, plain strings (added as text
// nodes), numbers (stringified), or null/undefined/false (skipped, so a
// conditional child reads `cond && h(...)`).
export type Child = Node | string | number | null | undefined | false;

// The attributes an element accepts. Strings set attributes; booleans toggle
// boolean attributes (true sets the empty attribute, false removes it);
// `class`/`className` set the class; `dataset` sets data-* attributes; `style`
// sets a style string; `on` wires event listeners; everything else is set as a
// string attribute (so aria-*, role, href, type, etc. all work).
export interface Attrs {
  class?: string;
  className?: string;
  id?: string;
  style?: string;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: Event) => void>>;
  // Any other attribute: string is set verbatim; boolean toggles; number is
  // stringified; null/undefined/false removes/omits the attribute.
  [name: string]: string | number | boolean | null | undefined | Record<string, string> | Attrs["on"];
}

// applyInlineStyle applies a CSS declaration string via the CSSOM (setProperty), NOT via the
// style attribute. This is what lets the console run under a strict Content-Security-Policy with
// style-src 'self' and no 'unsafe-inline': a setAttribute("style", ...) write is an inline style
// the CSP blocks, whereas per-property CSSOM writes are not gated by CSP (the same reason React's
// inline styles work under a strict policy). Declarations are semicolon-separated; each is split on
// its first colon; an !important suffix is honoured; custom properties (--x) are passed through.
function applyInlineStyle(node: HTMLElement, css: string): void {
  for (const decl of css.split(";")) {
    const trimmed = decl.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const prop = trimmed.slice(0, colon).trim();
    if (prop === "") continue;
    let val = trimmed.slice(colon + 1).trim();
    let priority = "";
    if (/!important$/i.test(val)) {
      priority = "important";
      val = val.replace(/!important$/i, "").trim();
    }
    node.style.setProperty(prop, val, priority);
  }
}

function applyAttrs(node: HTMLElement, attrs: Attrs): void {
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = String(value);
    } else if (key === "id") {
      node.id = String(value);
    } else if (key === "style") {
      applyInlineStyle(node, String(value));
    } else if (key === "dataset") {
      const ds = value as Record<string, string>;
      for (const dk of Object.keys(ds)) node.dataset[dk] = ds[dk]!;
    } else if (key === "on") {
      const handlers = value as Attrs["on"];
      if (handlers) {
        for (const ek of Object.keys(handlers) as (keyof HTMLElementEventMap)[]) {
          const fn = handlers[ek];
          if (fn) node.addEventListener(ek, fn);
        }
      }
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function appendChildren(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
}

// h(tag, attrs?, ...children) builds an HTML element. Overloaded so attrs are
// optional: h("div", "text") and h("div", { class: "x" }, "text") both work.
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, ...children: Child[]): HTMLElementTagNameMap[K];
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs, ...children: Child[]): HTMLElementTagNameMap[K];
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrsOrChild?: Attrs | Child, ...rest: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (isAttrs(attrsOrChild)) {
    applyAttrs(node, attrsOrChild);
    appendChildren(node, rest);
  } else {
    appendChildren(node, [attrsOrChild as Child, ...rest]);
  }
  return node;
}

// isAttrs distinguishes a plain attrs object from a Node/string/number child.
// A Node has a nodeType; a plain object does not.
function isAttrs(x: Attrs | Child): x is Attrs {
  return (
    x !== null &&
    typeof x === "object" &&
    !(x instanceof Node)
  );
}

// text builds a bare text node (when a string child needs to stand alone, e.g.
// mixed inline content).
export function text(s: string | number): Text {
  return document.createTextNode(String(s));
}

// frag builds a DocumentFragment from children, for returning multiple siblings, or none at all
// (screens/overview/tiles.ts's calm-fleet banner bail-out: frag() with no arguments is an empty
// fragment, the same thing document.createDocumentFragment() was spelling out by hand).
export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// svgIcon renders one of the locally-authored inline SVG icons (lib/icons.ts).
// The path data is a trusted, in-repo constant (never server-supplied), so
// parsing it as SVG markup is safe; it is wrapped in a 24px-grid <svg> with
// currentColor stroke so the icon themes for free. An icon
// paired with a visible label is decorative (aria-hidden); a standalone icon
// button must carry its own aria-label on the button, not here.
export function svgIcon(pathMarkup: string, opts: { size?: number; label?: string } = {}): SVGSVGElement {
  const size = opts.size ?? 16;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (opts.label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  // The icon constants are in-repo and trusted; innerHTML here is over a known
  // constant, not server data. Setting it on an SVG element parses in the SVG
  // namespace so paths/polylines/circles render correctly.
  svg.innerHTML = pathMarkup;
  return svg;
}

// refuseWithReason marks an already-built control as refused, and it is the ONLY way this console
// should express a gate on a control. It lives HERE, beside h(), rather than in screens/common.ts,
// because components/ and screens/ both need it and components/ importing screens/ would be a
// circular dependency (lint:circular). screens/common.ts re-exports it, so every existing screen
// import site is unchanged.
//
// WHY NOT `disabled`. The disabled property removes the element from the tab order, so there is no
// keystroke that reaches it and no way for a keyboard or screen-reader user to discover WHY the
// console will not let them act. On a touch device the failure is worse: title fires on hover, and a
// phone has no hover, so a `disabled` + `title` control carries no reason at all. Writing both
// `disabled: true` and `aria-disabled: "true"` does not fix it either; the disabled property still
// removes the control from the tab order, so the ARIA state is announced to nobody. That combination
// reads as remediated and is not.
//
// THE REASON IS A DESCRIPTION, NOT PART OF THE NAME, and that is the correction of. The
// reason used to be appended as a plain visually-hidden child reading `: <reason>`, which made it a
// CONTRIBUTION to the control's accessible name. The browser's name-from-content algorithm joins
// sibling contributions with an inserted separator space regardless of the next one's own leading
// punctuation, so the control announced as "Remove token : Requires the Owner role", with the colon
// read out as a separate token. Measured in Chromium 149 rather than inferred: the same markup
// computes "Remove token : ..." with the plain span, and "Remove token" with the two attributes
// below, while the reason moves to the description where it belongs.
//
// Each of the three mechanisms is load-bearing, and each was measured on its own:
//   - aria-hidden on the span is what takes the reason OUT of the name-from-content join. Without it
//     the name is "Remove token Requires the Owner role" even when aria-describedby is set.
//   - aria-describedby is what puts the same text BACK as the description. Without it the name is
//     clean and the reason is announced to nobody, which is the silent version of the same defect.
//   - a referenced node is read even when it is aria-hidden, which is why the span can be both.
// The name a screen-reader user hears is now exactly the label a sighted user reads, and it FOLLOWS
// a label the screen rewrites at runtime, which an explicit aria-label of label-plus-reason does not
// (measured: that form still announced the old label after the visible text had changed).
//
// The reason stays REAL DOM TEXT rather than an aria-label string, so it survives in the document
// for anything that reads content rather than computed names, and it renders through h(), so it goes
// out via createTextNode and never innerHTML.
//
// The title is kept, not replaced: a mouse user loses nothing, and essential information must never
// live ONLY in a tooltip. It is written as an
// ATTRIBUTE rather than through the `title` property because the test DOM shim deliberately does not
// mirror `title` in either direction, so a reader going through getAttribute would see nothing.
//
// WHAT THIS DOES NOT DO: it does not stop the click. aria-disabled is an announcement, not an
// enforcement. Every caller must therefore attach no click handler on the gated branch, which is why
// this function takes a built element rather than wrapping the handler: the shape it is meant to be
// used in is `if (allowed) el.addEventListener(...); else refuseWithReason(el, r);` where the else
// branch cannot attach anything. The engine re-checks the same gate regardless, so the console's
// refusal has never been the only one.
export function refuseWithReason(el: HTMLElement, reason: string): void {
  el.setAttribute("aria-disabled", "true");
  el.setAttribute("title", reason);
  const reasonId = `refusal-${crypto.randomUUID().slice(0, 8)}`;
  el.appendChild(h("span", { class: "visually-hidden", id: reasonId, "aria-hidden": "true" }, reason));
  // Any ids the control is ALREADY described by are preserved: a gated control may also carry its
  // own standing hint, and clobbering that would trade one silence for another.
  const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter((id) => id !== "");
  ids.push(reasonId);
  el.setAttribute("aria-describedby", ids.join(" "));
}

// clear empties a node (used by the router/shell when swapping a region).
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// mount (a one-line host.replaceChildren(node) wrapper, meant as the production form of an old
// render(view) pattern) was removed: never called anywhere in the console's history
// since the foundation commit that added it. The redesign settled on calling
// .replaceChildren() directly at each of its 500+ region-swap sites instead of through a render(view)
// indirection, so the wrapper this wraps was never built, and wiring mount() in now would mean
// picking one of those sites arbitrarily rather than completing a migration that never started.

// scrollToSafe: the ONLY sanctioned way to smooth-scroll. The CSS reduced-motion
// gate cannot govern the imperative scrollIntoView API in all engines, so callers
// that want behavior:"smooth" must come through here: under reduced motion, the
// OS preference OR the in-app setting (the data-motion attribute lib/a11y-prefs
// writes), the scroll still happens (information is never motion-gated) but
// instantly. The attribute is read directly so this base module imports nothing.
export function scrollToSafe(el: Element, opts: ScrollIntoViewOptions = {}): void {
  const reduced =
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) ||
    document.documentElement.getAttribute("data-motion") === "reduced";
  el.scrollIntoView(reduced ? { ...opts, behavior: "auto" } : opts);
}
