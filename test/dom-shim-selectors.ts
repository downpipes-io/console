// Selector matching for the DOM shim, split out of dom-shim.ts. Enough of CSS for the components
// under test (dialog.ts's FOCUSABLE_SELECTOR and the descendant combinators the tests use, e.g.
// ".detail-drawer__badges .badge"). dom-shim.ts re-exports selectorListMatches so importers are
// unchanged. ShimNode is imported type-only so this module stays free of a runtime cycle.

import type { ShimNode } from "./dom-shim-core.ts";

// ---- selector matching: tag | .class | #id | [attr] | [attr="v"] | :not([...]) | descendant ----
// A comma is a selector list; a space is a descendant combinator (the rightmost compound must
// match the node, each earlier compound must match some ancestor, in order); a compound like
// button:not([disabled]) is split into its base (button) and a :not([disabled]) exclusion.
export function selectorListMatches(node: ShimNode, selectorList: string): boolean {
  for (const sel of splitTopLevel(selectorList, ",")) {
    if (descendantMatches(node, sel.trim())) return true;
  }
  return false;
}

// descendantMatches resolves a space-separated descendant selector against node by matching the
// rightmost compound on node, then walking up the ancestor chain to satisfy each earlier compound
// in right-to-left order (the standard subject-last evaluation).
function descendantMatches(node: ShimNode, selector: string): boolean {
  const parts = splitTopLevel(selector, " ").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return compoundMatches(node, parts[0]!);
  // Rightmost must match the node itself.
  if (!compoundMatches(node, parts[parts.length - 1]!)) return false;
  let ancestor = node.parentNode;
  let i = parts.length - 2;
  while (i >= 0 && ancestor) {
    if (ancestor.nodeType === 1 && compoundMatches(ancestor, parts[i]!)) {
      i--;
    }
    ancestor = ancestor.parentNode;
  }
  return i < 0;
}

// splitTopLevel splits on a separator that is NOT inside [] or () (so [attr="a,b"] and :not(.a .b)
// are not mis-split). Adequate for the selectors the tests use.
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depthBracket = 0;
  let depthParen = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === "(") depthParen++;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    if (ch === sep && depthBracket === 0 && depthParen === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.filter((p) => p !== "");
}

function compoundMatches(node: ShimNode, sel: string): boolean {
  // Pull out every :not(...) clause first; each inner selector must NOT match.
  const notClauses: string[] = [];
  let base = sel.replace(/:not\(([^)]*)\)/g, (_m, inner: string) => {
    notClauses.push(inner.trim());
    return "";
  });
  base = base.trim();
  if (!simpleMatches(node, base)) return false;
  for (const nc of notClauses) {
    if (simpleMatches(node, nc)) return false;
  }
  return true;
}

// A simple selector is a concatenation of an optional tag and any number of .class / #id /
// [attr] / [attr="value"] pieces, all of which must hold. An empty selector matches any element.
function simpleMatches(node: ShimNode, sel: string): boolean {
  if (sel === "" || sel === "*") return true;
  const tokenRe = /([.#][\w-]+)|(\[[^\]]*\])|([\w-]+)/g;
  for (let m = tokenRe.exec(sel); m !== null; m = tokenRe.exec(sel)) {
    const tok = m[0];
    if (tok.startsWith(".")) {
      if (!node.classList.contains(tok.slice(1))) return false;
    } else if (tok.startsWith("#")) {
      if (node.id !== tok.slice(1)) return false;
    } else if (tok.startsWith("[")) {
      if (!attrMatches(node, tok.slice(1, -1))) return false;
    } else {
      // tag
      if (node.tagName !== tok.toUpperCase()) return false;
    }
  }
  return true;
}

function attrMatches(node: ShimNode, body: string): boolean {
  const eq = body.indexOf("=");
  if (eq === -1) {
    return node.hasAttribute(body.trim());
  }
  const name = body.slice(0, eq).trim();
  let val = body.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  // The boolean attributes (disabled) are stored as "" by the setters; a [disabled] presence
  // check is handled above, so an [disabled] with a value is uncommon. Compare the string value.
  if (name === "tabindex") return String(node.tabIndex) === val;
  return node.getAttribute(name) === val;
}
