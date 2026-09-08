// Core node/element classes for the DOM shim, split out of dom-shim.ts. ShimNode is the heart of
// the shim: the tree ops, the mapped properties, classList / dataset / style, event listeners and
// dispatch, and the querySelector family. dom-shim.ts re-exports these so importers are unchanged.
//
// The shared SHIM_DOC / SHIM_BODY singletons live in dom-shim-env.ts so the document installer can
// populate them without forming a runtime cycle with this module.

import { env } from "./dom-shim-env.ts";
import { selectorListMatches } from "./dom-shim-selectors.ts";
import type { ShimEvent, ShimEventInit } from "./dom-shim-types.ts";

let nodeSeq = 0;

class ShimClassList {
  node: ShimNode;
  set: Set<string> = new Set();
  constructor(node: ShimNode) {
    this.node = node;
  }
  add(...cs: string[]): void {
    for (const c of cs) this.set.add(c);
    this.sync();
  }
  remove(...cs: string[]): void {
    for (const c of cs) this.set.delete(c);
    this.sync();
  }
  toggle(c: string, force?: boolean): boolean {
    const want = force === undefined ? !this.set.has(c) : force;
    if (want) this.set.add(c);
    else this.set.delete(c);
    this.sync();
    return want;
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
  sync(): void {
    this.node.attrs.class = [...this.set].join(" ");
  }
}

// ShimStyle records both the CSSOM setProperty writes and direct property writes (svg.style.color
// = ...). Reading back a property returns whatever was last written. setProperty is the path the
// production dom.ts uses (never setAttribute("style", ...)), so this keeps the CSP-safe contract.
class ShimStyle {
  [prop: string]: string | ((p: string, v: string, priority?: string) => void);
  setProperty(prop: string, value: string, _priority?: string): void {
    this[prop] = value;
  }
  getPropertyValue(prop: string): string {
    const v = this[prop];
    return typeof v === "string" ? v : "";
  }
}

// camelCase data-key <-> data-key kebab attribute name, as the real DOMStringMap does.
function datasetKeyToAttr(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

// makeDatasetProxy returns a DOMStringMap-like object whose reads, writes and deletes
// round-trip through the node's data-* attributes (so [data-key] selectors resolve).
function makeDatasetProxy(node: { attrs: Record<string, string> }): Record<string, string> {
  return new Proxy({} as Record<string, string>, {
    get(_t, prop: string): string | undefined {
      if (typeof prop !== "string") return undefined;
      return node.attrs[datasetKeyToAttr(prop)];
    },
    set(_t, prop: string, value): boolean {
      node.attrs[datasetKeyToAttr(prop)] = String(value);
      return true;
    },
    deleteProperty(_t, prop: string): boolean {
      delete node.attrs[datasetKeyToAttr(prop)];
      return true;
    },
    has(_t, prop: string): boolean {
      return datasetKeyToAttr(prop) in node.attrs;
    },
  });
}

export class ShimNode {
  id_: number;
  kind: "element" | "text" | "fragment";
  nodeType: number;
  childNodes: ShimNode[] = [];
  parentNode: ShimNode | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: ShimEvent) => void>> = {};
  text_ = "";
  // dataset reflects to data-* attributes exactly as the real DOM does (writing
  // node.dataset.key = "v" exposes a data-key="v" attribute, so a [data-key] selector
  // resolves). Backed by a Proxy over attrs so reads, writes and deletes round-trip.
  dataset: Record<string, string> = makeDatasetProxy(this);
  style: ShimStyle = new ShimStyle();
  classList: ShimClassList;
  hidden_ = false;
  value_ = "";
  // The dirty-value flag, mirroring the real one. A control's `value` content attribute seeds the
  // DEFAULT value, and `.value` returns that default until the value is dirtied, after which the
  // attribute no longer moves it. Tracked so setAttribute("value", ...) can seed the property faithfully
  // without clobbering a value the operator (or a test) has since typed.
  valueDirty_ = false;
  disabled_ = false;
  placeholder_ = "";
  checked_ = false;
  // The tri-state checkbox flag. Production sets it on the select-all box when some but not all rows are
  // selected (data-table-rows.ts), and in the real DOM it is a plain property with no attribute behind
  // it, so a plain field is a faithful shim. Declared rather than left to land implicitly: untyped, a
  // test asserting on it reads `any`, and a typo in the name would quietly assert undefined.
  indeterminate = false;
  // Scroll offset. The virtualised table READS this off its viewport to decide which rows to render, and
  // tests drive it to simulate scrolling, so it has to be a settable number rather than something that
  // happens to exist because JavaScript objects accept any property.
  scrollTop = 0;
  innerHTML_ = "";
  tagName = "";
  localName = "";
  namespaceURI: string | null = null;
  connectedRoot_ = false;
  tabIndex_ = 0;
  // Whether the element is laid out (offsetParent non-null). Visible by default so the
  // focus trap's isVisible() check passes for rendered controls.
  visible_ = true;

  constructor(kind: "element" | "text" | "fragment") {
    this.id_ = ++nodeSeq;
    this.kind = kind;
    this.nodeType = kind === "text" ? 3 : kind === "fragment" ? 11 : 1;
    this.classList = new ShimClassList(this);
  }

  appendChild(child: ShimNode | string | number | null): ShimNode | null {
    if (child == null) return null;
    // Mirror the browser: append/replaceChildren accept raw strings and numbers, coercing them to
    // text nodes. The framework's h() coerces before it reaches here, but direct replaceChildren
    // calls (e.g. the editor's "First run about " line) pass a bare string, so coerce it here too.
    if (typeof child === "string" || typeof child === "number") {
      const t = new ShimNode("text");
      t.text_ = String(child);
      child = t;
    }
    if (child.kind === "fragment") {
      for (const c of [...child.childNodes]) this.appendChild(c);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  // insertBefore(node, ref) places node ahead of ref, and appends when ref is null, which is the browser's
  // own rule. The shim went without it until the attended-verification RESUME banner needed driving: that
  // banner is inserted ahead of the fresh setup form, so any test that reached it died on "insertBefore is
  // not a function" rather than on an assertion. A missing method is not a neutral gap here, because the
  // surfaces it hides are exactly the ones nothing has tested.
  insertBefore(child: ShimNode | string | number | null, ref: ShimNode | null): ShimNode | null {
    if (child == null) return null;
    if (typeof child === "string" || typeof child === "number") {
      const t = new ShimNode("text");
      t.text_ = String(child);
      child = t;
    }
    if (child.kind === "fragment") {
      for (const c of [...child.childNodes]) this.insertBefore(c, ref);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = ref === null ? -1 : this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  }
  // nextSibling is what "afterend" is defined against, and the shim had neither. Kept as a real accessor
  // rather than inlined into insertAdjacentElement, because a reader walking a node list gets undefined
  // otherwise, which is falsy and so ends the walk immediately instead of failing.
  get nextSibling(): ShimNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i < 0 ? null : this.parentNode.childNodes[i + 1] ?? null;
  }
  // insertAdjacentElement places a node relative to THIS one. Absent from the shim until the passkey-prompt
  // sentence in screens/idp-connections/form-actions.ts anchored itself to the submit error slot: the call
  // threw "insertAdjacentElement is not a function" during render, so every one of the ten IdP presets failed
  // to render a form and both validate-idp.ts and validate-idp-presets-drift.ts died before their tally. That
  // is the shim being the defect and not the product, since both callers append the error slot to the form
  // before wiring the actions, so the node has a parent and a real browser inserts without complaint.
  //
  // The no-parent case RETURNS NULL rather than throwing, which is the DOM specification's own rule for
  // beforebegin and afterend, and it is the fidelity that matters here: a shim stricter than the browser
  // would redden a call production accepts, and one that threw where the browser silently inserts nothing
  // would hide a sentence that never reaches the screen. An unknown position throws, also as specified.
  insertAdjacentElement(position: string, el: ShimNode): ShimNode | null {
    switch (position) {
      case "beforebegin":
        return this.parentNode ? this.parentNode.insertBefore(el, this) : null;
      case "afterbegin":
        return this.insertBefore(el, this.firstChild);
      case "beforeend":
        return this.appendChild(el);
      case "afterend":
        return this.parentNode ? this.parentNode.insertBefore(el, this.nextSibling) : null;
      default:
        throw new Error(`insertAdjacentElement: unknown position "${position}"`);
    }
  }
  removeChild(child: ShimNode): ShimNode {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      child.parentNode = null;
      // Detaching a subtree takes focus off anything inside it: the browser drops document.activeElement
      // to the body and every later keystroke goes there. The shim tracked focus only through focus() and
      // blur(), so a repaint that tore down the focused control left activeElement pointing at a node no
      // longer in the document, and a cell driving that screen carried on typing into it and passed.
      //
      // That is not a hypothetical. It is how the R2 other-account override shipped a field that accepted
      // exactly ONE character: paintState called replaceChildren on the slot holding the focused Account
      // ID on every input event, and replaceChildren removes before it inserts. The cell written for that
      // override passed against this shim while chromium held "9" of a 32-character id with activeElement
      // on BODY. Modelling the drop here is what lets a cell tell those two apart.
      if (env.SHIM_DOC?.activeElement && child.contains(env.SHIM_DOC.activeElement)) {
        env.SHIM_DOC.activeElement = env.SHIM_BODY;
      }
    }
    return child;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes: Array<ShimNode | string | number>): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const n of nodes) this.appendChild(n);
  }
  get firstChild(): ShimNode | null {
    return this.childNodes[0] ?? null;
  }
  // Real DOM: the first child that is an ELEMENT, skipping text nodes. Absent from the shim until now, and
  // its absence is silent in the worst way: `const panel = region.firstElementChild; if (panel) panel.focus()`
  // reads undefined, takes the falsy branch and does nothing, so a screen that DOES move focus in production
  // looks under test exactly like one that never tried. The Integrations open path is one such reader.
  get firstElementChild(): ShimNode | null {
    return this.childNodes.find((c) => c.nodeType === 1) ?? null;
  }
  get parentElement(): ShimNode | null {
    // Real DOM: parentElement is parentNode when (and only when) the parent is an element.
    // Code that walks btn.parentElement (the gated-primary hint removal, for one) silently
    // no-ops under the shim without this, passing where production behaves differently.
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get childElementCount(): number {
    return this.childNodes.filter((c) => c.nodeType === 1).length;
  }
  get children(): ShimNode[] {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get isConnected(): boolean {
    let n: ShimNode | null = this;
    while (n) {
      if (n.connectedRoot_) return true;
      n = n.parentNode;
    }
    return false;
  }

  setAttribute(k: string, v: string): void {
    if (k === "class") {
      this.attrs.class = String(v);
      this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
      return;
    }
    if (k === "tabindex") {
      this.tabIndex_ = Number(v);
    }
    if (k === "checked") {
      // checked is a boolean HTML attribute: h()'s attrs-based `checked: true` calls
      // setAttribute("checked", "") (applyAttrs skips `checked: false` entirely -- it is never called
      // with a falsy value). Real DOM boolean-attribute semantics is presence-based (any value, even the
      // empty string, means true), and that presence also seeds the live IDL property; mirror that here
      // so a checkbox built via h(..., { checked: true }) reads back .checked === true, not just the
      // content attribute. Without this a production checkbox can render visibly ticked while every test
      // reading .checked sees it unticked, hiding real bugs behind the shim rather than exercising them.
      this.checked_ = true;
    }
    if (k === "value" && !this.valueDirty_) {
      // value is NOT presence-based like checked and disabled, but it has the same trap: h()'s
      // attrs-based `value: "d1"` reaches here as a content attribute, and in a real browser that
      // becomes the control's value, so production code reading `.value` sees "d1". Without this the
      // shim left `.value` as the empty string while getAttribute("value") held "d1", so any production
      // code reading the property saw nothing.
      //
      // Found via destination-fanout.ts: it builds its checkboxes with `value: x.id` and recompute()
      // maps ticked boxes through `cb.value` to report the chosen destination ids. Under the old shim
      // every reported id was "", so a test asserting "the ticked ids are reported in list order" could
      // only ever have compared empty strings and would have passed while proving nothing. That is the
      // shim being differently wrong from a browser, which is worse than being stricter: it hides the
      // behaviour instead of exercising it. Same reasoning as the checked and disabled cases above.
      this.value_ = String(v);
    }
    if (k === "disabled") {
      // disabled is presence-based like checked, but unlike checked it has no dirty-property
      // semantics: the IDL property mirrors the content attribute in BOTH directions, so
      // setAttribute seeds it true and removeAttribute (below) clears it. Without this a
      // button built via h(..., { disabled: true }) reads back .disabled === false, and any
      // code guarded on the property (enableGatedPrimary's idempotence check, the cardActions
      // click guard) takes the wrong branch under the shim while production takes the right one.
      this.disabled_ = true;
    }
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    if (k === "disabled") this.disabled_ = false;
    delete this.attrs[k];
  }
  hasAttribute(k: string): boolean {
    return k in this.attrs;
  }

  set className(v: string) {
    this.setAttribute("class", String(v));
  }
  get className(): string {
    return this.attrs.class ?? "";
  }
  set id(v: string) {
    this.attrs.id = String(v);
  }
  get id(): string {
    return this.attrs.id ?? "";
  }
  set hidden(v: boolean) {
    this.hidden_ = !!v;
    if (v) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  get hidden(): boolean {
    return this.hidden_;
  }
  set value(v: string) {
    // A direct property assignment dirties the value, so a later setAttribute("value", ...) must not
    // overwrite it. This is what distinguishes value from disabled, whose property and attribute mirror
    // each other in both directions.
    this.valueDirty_ = true;
    this.value_ = String(v);
  }
  get value(): string {
    return this.value_;
  }
  set disabled(v: boolean) {
    this.disabled_ = !!v;
    if (v) this.attrs.disabled = "";
    else delete this.attrs.disabled;
  }
  get disabled(): boolean {
    return this.disabled_;
  }
  // options: a <select>'s own option elements, as the real HTMLSelectElement exposes them. The console reads it
  // (the notification rule form disables the per-downpipe scope when no downpipe exists), and a shim that lacks
  // it makes a REAL screen unrenderable in a test, which is how a real form went undriven.
  get options(): ShimNode[] {
    return this.children.filter((c) => c.tagName === "OPTION");
  }
  // target: an anchor's content attribute has no dirty-property split (unlike value/checked above), so
  // the property is a plain mirror of the attribute, same shape as `id`. app-external-link.ts reads
  // `anchor.target` as a live property (not getAttribute), and h()'s attrs-based `target: "_blank"`
  // only reaches here as a content attribute, so without this the property read back "" always.
  set target(v: string) {
    this.attrs.target = String(v);
  }
  get target(): string {
    return this.attrs.target ?? "";
  }
  set placeholder(v: string) {
    this.placeholder_ = String(v);
  }
  get placeholder(): string {
    return this.placeholder_;
  }
  set checked(v: boolean) {
    this.checked_ = !!v;
  }
  get checked(): boolean {
    return this.checked_;
  }
  set innerHTML(v: string) {
    this.innerHTML_ = String(v);
  }
  get innerHTML(): string {
    return this.innerHTML_;
  }
  set tabIndex(v: number) {
    this.tabIndex_ = v;
    this.attrs.tabindex = String(v);
  }
  get tabIndex(): number {
    if ("tabindex" in this.attrs) return Number(this.attrs.tabindex);
    return this.tabIndex_;
  }
  // offsetParent: null when not visible (the focus trap reads this to skip hidden controls).
  get offsetParent(): ShimNode | null {
    return this.visible_ ? this.parentNode ?? env.SHIM_BODY : null;
  }

  set textContent(v: string) {
    this.text_ = v == null ? "" : String(v);
    this.childNodes = [];
  }
  get textContent(): string {
    if (this.kind === "text") return this.text_;
    let out = this.text_ || "";
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  addEventListener(type: string, fn: (ev: ShimEvent) => void): void {
    this.listeners[type] ||= []; this.listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: (ev: ShimEvent) => void): void {
    const l = this.listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(ev: ShimEvent): boolean {
    ev.target = ev.target ?? this;
    // Walk up the tree firing listeners (capture not modelled; bubbling is enough for these
    // components, which attach at the element they care about). stopPropagation halts the walk.
    let node: ShimNode | null = this;
    let stopped = false;
    const stop = ev.stopPropagation.bind(ev);
    ev.stopPropagation = () => {
      stopped = true;
      stop();
    };
    while (node) {
      ev.currentTarget = node;
      for (const fn of [...(node.listeners[ev.type] ?? [])]) fn.call(node, ev);
      if (stopped || !ev.bubbles) break;
      node = node.parentNode;
    }
    return !ev.defaultPrevented;
  }
  click(): void {
    this.dispatchEvent(makeEvent({ type: "click", bubbles: true, cancelable: true }));
  }
  // scrollIntoView is a no-op because the shim models no layout and no viewport, but it has to EXIST:
  // lib/dom.ts's scrollToSafe() calls it on every screen that scrolls a panel into view, and an absent
  // method throws, which reads in a test as a fault in the screen rather than a gap in the shim.
  scrollIntoView(_opts?: unknown): void {}
  focus(): void {
    if (env.SHIM_DOC) env.SHIM_DOC.activeElement = this;
  }
  blur(): void {
    if (env.SHIM_DOC && env.SHIM_DOC.activeElement === this) {
      env.SHIM_DOC.activeElement = env.SHIM_BODY;
    }
  }

  closest(sel: string): ShimNode | null {
    let n: ShimNode | null = this;
    while (n) {
      if (n.nodeType === 1 && selectorListMatches(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }

  walk(cb: (n: ShimNode) => void): void {
    for (const c of this.childNodes) {
      cb(c);
      c.walk(cb);
    }
  }
  querySelector(sel: string): ShimNode | null {
    let found: ShimNode | null = null;
    this.walk((n) => {
      if (!found && n.nodeType === 1 && selectorListMatches(n, sel)) found = n;
    });
    return found;
  }
  querySelectorAll(sel: string): ShimNode[] {
    const out: ShimNode[] = [];
    this.walk((n) => {
      if (n.nodeType === 1 && selectorListMatches(n, sel)) out.push(n);
    });
    return out;
  }
  contains(other: ShimNode | null): boolean {
    let n: ShimNode | null = other;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }
}

export class ShimElement extends ShimNode {
  constructor(tag: string, ns: string | null = null) {
    super("element");
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.namespaceURI = ns;
  }
}

export function makeEvent(init: ShimEventInit): ShimEvent {
  return {
    type: init.type,
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    bubbles: init.bubbles ?? false,
    preventDefault() {
      if (init.cancelable !== false) this.defaultPrevented = true;
    },
    stopPropagation() {
      /* replaced per-dispatch */
    },
  };
}
