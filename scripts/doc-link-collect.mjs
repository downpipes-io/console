// Doc-link gate scanner for scripts/verify-doc-links.mjs, kept apart so test/validate-doc-link-collect.ts
// can drive it against fixture text rather than the live tree.
//
// DESIGN: AN ALLOWLIST, NOT A RESOLVER. The scanner does not try to work out what a computed string will
// hold. It finds every place the docs host is written and accepts only the few forms it can grade with
// certainty. Anything else FAILS the gate with file:line.
//
// DETECTION DOES NOT TRUST THE LEXER. The raw file text is normalised (JS escapes decoded, percent-decoded,
// NFKC, fullwidth and ideographic dots folded, every combining, variation, zero-width and format character
// removed, lower-cased) and EVERY occurrence of "downpipes.io" is found in it. Each occurrence must be
// accounted for by exactly one form below. A file the lexer cannot finish, or an occurrence the lexer did
// not place inside an allowed form, fails. A "/" can be a division or the start of a regular expression, and
// the lexer cannot always tell which. Where it cannot (after ")", "]", "}", "++" or "--"), the file is lexed
// again with that "/" read the other way, and with all of them flipped; if ANY reading places an occurrence
// outside an allowed form, the gate fails with that file:line. A reading that does not lex to the end is
// not a possible reading of the file and is ignored.
//
// ALLOWED FORMS for the docs host (docs.downpipes.io):
//   1. A complete link: ONE plain string literal ('...', "..." or a template with no ${ }), pure ASCII, of the
//      exact form https://docs.downpipes.io/<path>[#anchor], standing alone as a value. "Standing alone"
//      means it is not an operand of +, ||, &&, ??, ?:, as, !, nothing is chained onto it, and it is not
//      assigned to a name that can change (only `const NAME = ...` may take it with "=").
//   2. The existing helpers with plain literal arguments: docLink({ href, anchor, label }), groupDocLink(url,
//      label), `href: CONST` where CONST is `const NAME = <form 1>`, and the integrations catalogue template
//      https://docs.downpipes.io/integrations/${slug}, expanded from the real catalogue (templateValues).
//   3. A comment, as every reading of the file finds it. (A regular expression literal is NOT exempt.)
//   4. Prose: a standalone plain string literal that holds whitespace, where the host is written exactly as
//      docs.downpipes.io and is followed by whitespace, sentence punctuation, the end, or a /path (which is
//      graded like form 1).
// Other domains (support@downpipes.io, tour.downpipes.io, https://downpipes.io) are accepted when the text
// inside the same literal shows they cannot be the docs host; a bare "downpipes.io" or ".downpipes.io" that
// starts a literal that is part of a larger expression fails, because the rest could be "docs".
//
// LINK OBJECTS. The object literal that holds a docs link (href: <link>) may hold only: href once; anchor
// once, as one plain ASCII string literal; and other keys. A spread, a computed key, a quoted or shorthand
// href or anchor, a second href or anchor, or an anchor value that is not one plain literal FAILS.
//
// FIX. --fix WRITES NOTHING. proposeFix() returns, per link, the line, the line as it is and the line as it
// would be, for a person to apply.
//
// THE STATED LIMITS, each pinned by test/validate-doc-link-collect.ts:
//   1. A host assembled from pieces with no "downpipes.io" text anywhere in the source, such as
//      "https://docs." + ["downpipes", "io"].join("."), is not caught. No rule on source text can tell that
//      an arbitrary computed string is the docs host. This is the only limit on finding a host.
//   2. A value built from a graded constant plus more text (L + "-x", L.replace(...), obj.href += "#x" on an
//      object that was written with a docs link) grades only the constant: the added text holds no host text.
//   3. Deliberately obfuscated host text is not decoded: control characters or fillers inside the host,
//      multi-byte percent-encoding (%C2%AD), and HTML entities (&#46;). The gate guards the truth of the
//      links our own source states; it is not a defence against someone hiding a host on purpose.
// A .tsx or .jsx file with JSX markup does not lex as plain script and is reported unreadable, which is the
// intended result.
//
// FS-WRITES: none outside this repo

const HELPERS = ["groupDocLink"];
const LINK_RE = /^https:\/\/docs\.downpipes\.io\/[^\s\\"'`$<>]*$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const NOT_STATEMENT_WORDS = new Set(["as", "in", "of", "instanceof", "satisfies", "is"]);

/** True for a file name the gate reads: TypeScript or JavaScript, never a declaration file. */
export function isSourceFile(name) {
  if (/\.d\.[cm]?ts$/.test(name)) return false;
  return /\.(?:[cm]?[jt]s|[jt]sx|json)$/.test(name);
}

/** True for a directory the gate does not read: installed packages anywhere, build output at src's top level. */
export function isSkippedDir(name, topLevel = false) {
  if (name === "node_modules" || name === ".wrangler") return true;
  return topLevel && (name === "dist" || name === "build");
}

/** @typedef {{ url: string, line: number, edit: { from: number, to: number } | null }} DocLink */
/** @typedef {{ line: number, why: string }} Unresolved */

/** Line number (1-based) of index `at`. */
function lineOf(text, at) {
  let n = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// True when a "/" at this point starts a regular expression rather than dividing.
function slashStartsRegex(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  const c = text[j];
  if ("(,=:[!&|?{};+-*%<>~^".includes(c)) return true;
  if (/[a-z]/i.test(c)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(text[k])) k--;
    return /^(return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(text.slice(k + 1, j + 1));
  }
  return false;
}

// A "/" is AMBIGUOUS when the text before it does not settle division against a regular expression: after
// ")", "]" or "}" (if (x) /re/.test(s) against (a + b) / 2) and after "++" or "--" (i++ / 2).
function slashIsAmbiguous(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return false;
  const c = text[j];
  if (c === ")" || c === "]" || c === "}") return true;
  return (c === "+" || c === "-") && text[j - 1] === c;
}

/** @typedef {{ at: number, text: string }} Part */
/** @typedef {{ start: number, end: number, parts: Part[], dynamic: boolean }} Lit */
/** @typedef {{ masked: string, strings: Lit[], comments: Array<[number, number]>, ambiguous: number[] }} Lexed */

/**
 * One pass over the source. Returns the masked text (same length; comment and string bodies blanked,
 * newlines kept, quote marks and template `${ }` code kept), every string with its static parts, every
 * comment span, and the positions of the ambiguous "/" (see slashIsAmbiguous). `flip` reads those the
 * other way: "all" flips every one, a Set flips only the listed positions.
 * @param {string} text
 * @param {"all" | Set<number> | null} [flip]
 * @returns {Lexed | { error: string, at: number }}
 */
function lex(text, flip = null) {
  const out = text.split("");
  /** @type {Lit[]} */
  const strings = [];
  /** @type {Array<[number, number]>} */
  const comments = [];
  /** @type {number[]} */
  const ambiguous = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  // Stack of template-expression brace depths: when non-empty and a "}" closes one, resume the template.
  /** @type {Array<{ depth: number, cur: Lit }>} */
  const tplStack = [];
  let braceDepth = 0;
  let i = 0;
  // Reads a template body from `i` (just after "`" or after the closing "}" of an expression).
  /** @param {Lit} cur */
  const readTemplate = (cur) => {
    let j = i;
    const partStart = j;
    while (j < text.length) {
      const c = text[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "`") {
        cur.parts.push({ at: partStart, text: text.slice(partStart, j) });
        blank(partStart, j);
        cur.end = j + 1;
        i = j + 1;
        return true;
      }
      if (c === "$" && text[j + 1] === "{") {
        cur.parts.push({ at: partStart, text: text.slice(partStart, j) });
        blank(partStart, j);
        cur.dynamic = true;
        tplStack.push({ depth: braceDepth, cur });
        braceDepth++;
        i = j + 2;
        return true;
      }
      j++;
    }
    return false;
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      comments.push([i, j]);
      blank(i, j);
      i = j;
    } else if (c === "/" && n === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) return { error: "unterminated block comment", at: i };
      comments.push([i, j + 2]);
      blank(i, j + 2);
      i = j + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++;
        else if (text[j] === "\n") return { error: "unterminated string", at: i };
        j++;
      }
      if (j >= text.length) return { error: "unterminated string", at: i };
      strings.push({ start: i, end: j + 1, parts: [{ at: i + 1, text: text.slice(i + 1, j) }], dynamic: false });
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "`") {
      /** @type {Lit} */
      const cur = { start: i, end: -1, parts: [], dynamic: false };
      strings.push(cur);
      i++;
      if (!readTemplate(cur)) return { error: "unterminated template literal", at: cur.start };
    } else if (c === "/" && (() => {
      const amb = slashIsAmbiguous(text, i);
      if (amb) ambiguous.push(i);
      const heuristic = slashStartsRegex(text, i);
      return amb && flip !== null && (flip === "all" || flip.has(i)) ? !heuristic : heuristic;
    })()) {
      let j = i + 1;
      let cls = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") cls = true;
        else if (text[j] === "]") cls = false;
        else if (text[j] === "/" && !cls) break;
        j++;
      }
      if (j >= text.length || text[j] !== "/") return { error: "unterminated regular expression", at: i };
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "{") {
      braceDepth++;
      i++;
    } else if (c === "}") {
      braceDepth--;
      i++;
      const top = tplStack[tplStack.length - 1];
      if (top && top.depth === braceDepth) {
        tplStack.pop();
        if (!readTemplate(top.cur)) return { error: "unterminated template literal", at: top.cur.start };
      }
    } else {
      i++;
    }
  }
  if (tplStack.length > 0) return { error: "unterminated template expression", at: tplStack[0].cur.start };
  return { masked: out.join(""), strings, comments, ambiguous };
}

// The span [open, close] of the innermost { ... } around `at`, counted on masked text. Null when none.
function enclosingSpan(masked, at) {
  let depth = 0;
  let open = -1;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open < 0) return null;
  depth = 0;
  for (let i = at; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) return [open, i + 1];
      depth--;
    }
  }
  return null;
}

// The span of the brace group that starts at `open`, or null.
function spanFrom(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return [open, i + 1];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Normalisation for detection. Each source token (an escape, a %XX, or one code point) is decoded, folded and
// lower-cased on its own, and every output character remembers the index of the token it came from, so an
// occurrence found in the normalised text points back to the real file position.
// ---------------------------------------------------------------------------------------------------------
const TOKEN = /\\x([0-9a-fA-F]{2})|\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|%([0-9a-fA-F]{2})|(\\\r?\n)|\\([^\r\n])|[\s\S]/uy;
const ESCAPED = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

/**
 * @param {string} text
 * @returns {{ norm: string, map: number[] }}
 */
function normalise(text) {
  const out = [];
  const map = [];
  let i = 0;
  while (i < text.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(text);
    if (!m) { i++; continue; }
    let ch = m[0];
    try {
      if (m[1]) ch = String.fromCharCode(parseInt(m[1], 16));
      else if (m[2]) ch = String.fromCodePoint(parseInt(m[2], 16));
      else if (m[3]) ch = String.fromCharCode(parseInt(m[3], 16));
      else if (m[4]) ch = String.fromCharCode(parseInt(m[4], 16));
      else if (m[5]) ch = ""; // a backslash-newline line continuation denotes nothing
      else if (m[6]) ch = ESCAPED[m[6]] ?? m[6];
    } catch { ch = "�"; }
    ch = ch
      .normalize("NFKC")
      .replace(/[。．｡]/g, ".")
      .replace(/\p{M}|\p{Cf}|͏|[︀-️]|[᠋-᠍]/gu, "")
      .toLowerCase();
    for (let q = 0; q < ch.length; q++) { out.push(ch[q]); map.push(i); }
    i += m[0].length;
  }
  return { norm: out.join(""), map };
}

/**
 * One reading of the file: the links and the places the docs host is in a form the scanner does not accept.
 * @param {string} text
 * @param {{ templateValues?: Record<string, string[]> }} opts
 * @param {Lexed} lx
 * @returns {{ urls: DocLink[], unresolved: Unresolved[] }}
 */
function scanReading(text, opts, lx) {
  const templateValues = opts.templateValues ?? {};
  /** @type {DocLink[]} */
  const urls = [];
  /** @type {Unresolved[]} */
  const unresolved = [];
  const seenU = new Set();
  const addUnresolved = (at, why) => {
    const line = lineOf(text, at);
    const k = `${line}:${why}`;
    if (!seenU.has(k)) { seenU.add(k); unresolved.push({ line, why }); }
  };
  const byKey = new Map();
  /** @param {string} url @param {number} at @param {{ from: number, to: number } | null} [edit] */
  const addUrl = (url, at, edit = null) => {
    const line = lineOf(text, at);
    const k = `${url}@${line}`;
    const old = byKey.get(k);
    if (old) { if (!old.edit && edit) old.edit = edit; return; }
    const rec = { url, line, edit };
    byKey.set(k, rec);
    urls.push(rec);
  };

  const { masked, strings, comments } = lx;
  // The text with comments blanked and strings kept: what an entry or a key really says.
  const clean = text.split("");
  for (const [a, b] of comments) for (let q = a; q < b; q++) if (clean[q] !== "\n") clean[q] = " ";
  const cleanText = clean.join("");
  const stringAt = new Map(strings.map((s) => [s.start, s]));
  const inSpan = (spans, p) => spans.some(([a, b]) => p >= a && p < b);
  /** @returns {Lit | null} the smallest string literal that holds index p, or null */
  const innermost = (p) => {
    /** @type {Lit | null} */
    let best = null;
    for (const c of strings) if (p > c.start && p < c.end && (best === null || c.end - c.start < best.end - best.start)) best = c;
    return best;
  };
  const prevSig = (at) => { let j = at - 1; while (j >= 0 && /\s/.test(masked[j])) j--; return j; };
  const nextSig = (at) => { let j = at; while (j < masked.length && /\s/.test(masked[j])) j++; return j; };

  // The property key whose colon is at masked[j], or null when that colon is not a property colon.
  const keyBefore = (j) => {
    const base = Math.max(0, j - 160);
    const m = /[{,]\s*([A-Za-z_$][\w$]*|(["'`])[^"'`]*\2)\s*:$/d.exec(masked.slice(base, j + 1));
    if (!m) return null;
    const span = m.indices?.[1];
    if (!span) return null;
    const [a, b] = span;
    return cleanText.slice(base + a, base + b).replace(/^["'`]|["'`]$/g, "");
  };

  // True when the string stands alone as a value: not an operand of + || && ?? ?: as ! and not chained onto.
  const standalone = (s) => {
    const j = prevSig(s.start);
    if (j < 0) return false;
    const c = masked[j];
    let prevOk = false;
    if (c === "(" || c === "[" || c === ",") prevOk = true;
    else if (c === "=") prevOk = !"+-*/%&|^<>!=?".includes(masked[j - 1] ?? " ") && /\bconst\s+[A-Za-z_$][\w$]*\s*(?::[^=;]*)?$/.test(masked.slice(Math.max(0, j - 160), j));
    else if (c === ">") prevOk = masked[j - 1] === "=";
    else if (c === ":") prevOk = keyBefore(j) !== null;
    else if (/\w/.test(c)) prevOk = /(?:^|[^\w$])(?:return|yield)$/.test(masked.slice(Math.max(0, j - 7), j + 1));
    if (!prevOk) return false;
    const k = nextSig(s.end);
    if (k >= masked.length) return true;
    const d = masked[k];
    if (d === ")" || d === "," || d === ";" || d === "}" || d === "]") return true;
    if (/[A-Za-z_$]/.test(d) && text.slice(s.end, k).includes("\n")) {
      const w = /^[A-Za-z_$][\w$]*/.exec(masked.slice(k, k + 24))?.[0] ?? "";
      return !NOT_STATEMENT_WORDS.has(w);
    }
    return false;
  };

  // ----- 1. Account for every occurrence of "downpipes.io". ---------------------------------------------
  const { norm, map } = normalise(text);
  /** @type {Map<Lit, Array<{ p: number, partIdx: number }>>} docs-host occurrences by literal; p is the raw index of "downpipes" */
  const docsInLiteral = new Map();
  for (const om of norm.matchAll(/downpipes\.io/g)) {
    const k = om.index;
    const p = map[k];
    if (inSpan(comments, p)) continue;
    // The innermost literal that holds the occurrence.
    const s = innermost(p);
    if (s === null) {
      addUnresolved(p, "the text downpipes.io is written outside any string, comment or regular expression the scanner could place, so it is not graded");
      continue;
    }
    let partIdx = 0;
    let lo = s.start + 1;
    if (s.dynamic) {
      partIdx = s.parts.findIndex((pt) => p >= pt.at && p < pt.at + pt.text.length);
      if (partIdx < 0) { addUnresolved(p, "downpipes.io is written inside the code of a template expression"); continue; }
      lo = s.parts[partIdx].at;
    }
    let j = k;
    while (j > 0 && map[j - 1] >= lo && map[j - 1] > s.start) j--;
    const pre = norm.slice(j, k);
    let docs = false;
    let ok = true;
    // A string that starts after a ${ } substitution can be completed by that substitution ("https://${p}.x",
    // "${a}cs.x"), so it never stands alone.
    const alone = s.dynamic && partIdx > 0 ? false : standalone(s);
    if (/docs\.$/.test(pre)) docs = true;
    else if (pre === "") ok = alone;
    else if (!pre.endsWith(".")) ok = true;
    else {
      const label = /([a-z0-9-]*)\.$/.exec(pre)?.[1] ?? "";
      if (label === "") ok = alone;
      else if (label.length === pre.length - 1 && "docs".endsWith(label)) ok = alone;
      else ok = true;
    }
    if (!ok) {
      addUnresolved(p, "downpipes.io starts a string that is part of a larger expression, so the host it completes is not in the text");
      continue;
    }
    if (!docs) continue;
    const list = docsInLiteral.get(s) ?? [];
    list.push({ partIdx, p });
    docsInLiteral.set(s, list);
  }

  // ----- 2. Judge each literal that holds the docs host. -----------------------------------------------
  /** @type {Array<{ s: Lit, url: string, at: number, edit: { from: number, to: number } | null, kind: string }>} */
  const links = [];
  for (const [s, occs] of docsInLiteral) {
    const at0 = occs[0].p;
    if (s.dynamic) {
      // Only the integrations-style template: static prefix, one expression, nothing after it.
      const pref = s.parts[0].text;
      const vals = templateValues[pref];
      const plain = s.parts.length === 2 && s.parts[1].text === "" && occs.length === 1 && occs[0].partIdx === 0 && /^https:\/\/docs\.downpipes\.io\/[A-Za-z0-9/._-]*$/.test(pref);
      if (!plain || !vals || vals.length === 0 || !standalone(s)) {
        addUnresolved(at0, "a template that holds the docs host has an expression and no registered value list, or is not one plain prefix and one expression");
        continue;
      }
      for (const v of vals) links.push({ s, url: pref + v, at: s.start, edit: null, kind: "template" });
      continue;
    }
    if (!standalone(s)) {
      addUnresolved(at0, "the docs host is written in a string that is part of a larger expression (+, ||, ??, ?:, as, a call on the string), so the final URL is not in the text");
      continue;
    }
    const raw = text.slice(s.start + 1, s.end - 1);
    const base = s.start + 1;
    if (LINK_RE.test(raw) && PRINTABLE_ASCII.test(raw)) {
      const bad = occs.filter((o) => o.p - base - 5 !== 8);
      if (bad.length > 0) { addUnresolved(bad[0].p, "the docs host appears again inside a link"); continue; }
      const h = raw.indexOf("#");
      links.push({ s, url: raw, at: s.start, edit: h >= 0 ? { from: base + h, to: base + raw.length } : null, kind: "link" });
      continue;
    }
    if (/\s/.test(raw)) {
      // Prose: every occurrence is exactly "docs.downpipes.io", set apart from letters, and ends cleanly.
      let fine = true;
      for (const o of occs) {
        const off = o.p - base - 5; // index of "docs." in raw
        if (raw.slice(off, off + 17) !== "docs.downpipes.io" || /[A-Za-z0-9._-]/.test(raw[off - 1] ?? " ")) { fine = false; break; }
        const a = raw[off + 17];
        // A tab, carriage return or line feed beside the host or inside the path is dropped by a URL parser,
        // so the link would not be the one the text shows: fail rather than grade a cut path.
        if (a !== undefined && /[\t\r\n]/.test(a)) { fine = false; break; }
        if (a === undefined || /\s/.test(a) || ",;:)!?]'\"`".includes(a)) continue;
        if (a === ".") { const b = raw[off + 18]; if (b === undefined || b === " ") continue; fine = false; break; }
        if (a === "/") {
          const pm = /^\/[^\s"'`)\]<>]*/.exec(raw.slice(off + 17));
          const after = raw[off + 17 + (pm ? pm[0].length : 1)];
          if ((pm?.[0] ?? "").includes("\\") || (after !== undefined && /[\t\r\n]/.test(after))) { fine = false; break; }
          const path = (pm ? pm[0] : "/").replace(/[.,;:!?]+$/, "");
          links.push({ s, url: `https://docs.downpipes.io${path}`, at: s.start, edit: null, kind: "prose" });
          continue;
        }
        fine = false;
        break;
      }
      if (!fine) addUnresolved(at0, "the docs host in this sentence is not written exactly as docs.downpipes.io followed by whitespace, punctuation, the end or a /path");
      continue;
    }
    addUnresolved(at0, "the docs host is written in a string that is not a complete https://docs.downpipes.io/<path> link and is not a sentence");
  }

  // ----- 3. Declarations of docs constants, anchors, and the link objects. ------------------------------
  const declCount = new Map();
  for (const dm of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declCount.set(dm[1], (declCount.get(dm[1]) ?? 0) + 1);
  /** @type {Map<string, string>} */
  const docConsts = new Map();
  for (const l of links) {
    if (l.kind !== "link") continue;
    const j = prevSig(l.s.start);
    const cm = masked[j] === "=" ? /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?$/.exec(masked.slice(Math.max(0, j - 120), j)) : null;
    if (cm) {
      if ((declCount.get(cm[1]) ?? 0) > 1) addUnresolved(l.s.start, `${cm[1]} holds a docs link and is declared more than once in this file, so its value at a use is ambiguous`);
      else docConsts.set(cm[1], l.url);
    }
  }

  /** @typedef {{ value: string, from: number, to: number }} AnchorEntry */
  /** @typedef {{ fail?: string, anchor?: AnchorEntry | null, href?: { vAt: number, rest: string } | null }} ObjectInfo */
  // The entries of the object literal that starts at `open`, or a failure.
  /** @param {number} open @returns {ObjectInfo} */
  const parseObject = (open) => {
    const span = spanFrom(masked, open);
    if (!span) return { fail: "an object literal that holds a docs link is not closed" };
    /** @type {Array<{ a: number, b: number, absStart: number, t: string }>} */
    const entries = [];
    let depth = 0;
    let st = span[0] + 1;
    const cut = (a, b) => {
      const orig = cleanText.slice(a, b);
      const t = orig.trim();
      if (t === "") return;
      const absStart = a + (orig.length - orig.trimStart().length);
      entries.push({ a, b, absStart, t });
    };
    for (let i = span[0] + 1; i < span[1] - 1; i++) {
      const c = masked[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "," && depth === 0) { cut(st, i); st = i + 1; }
    }
    cut(st, span[1] - 1);
    /** @type {AnchorEntry | null} */
    let anchor = null;
    /** @type {{ vAt: number, rest: string } | null} */
    let href = null;
    let hrefs = 0;
    let anchors = 0;
    for (const e of entries) {
      if (e.t.startsWith("...")) return { fail: "a link object holds a spread, which can carry an anchor or href the text does not show" };
      if (e.t.startsWith("[")) return { fail: "a link object holds a computed key" };
      const km = /^(?:([A-Za-z_$][\w$]*)|"([^"\\\n]*)"|'([^'\\\n]*)')\s*:\s*/.exec(e.t);
      const sh = /^([A-Za-z_$][\w$]*)\s*$/.exec(e.t);
      const name = km ? (km[1] ?? km[2] ?? km[3]) : sh ? sh[1] : null;
      if (name !== "anchor" && name !== "href") continue;
      if (!km || km[1] === undefined) return { fail: `a link object holds ${name} as a shorthand or quoted key` };
      if (name === "href") { hrefs++; href = { vAt: e.absStart + km[0].length, rest: e.t.slice(km[0].length).trim() }; continue; }
      anchors++;
      const vAt = e.absStart + km[0].length;
      const s2 = stringAt.get(vAt);
      const raw2 = s2 && !s2.dynamic ? text.slice(s2.start + 1, s2.end - 1) : "";
      if (!s2 || s2.dynamic || masked.slice(s2.end, e.b).trim() !== "" || !PRINTABLE_ASCII.test(raw2) || raw2.includes("\\")) {
        return { fail: "a link object holds an anchor that is not one plain string literal" };
      }
      // The exact span to remove: this entry and one neighbouring comma.
      let from = e.absStart;
      let to = e.absStart + e.t.length;
      if (masked[e.b] === ",") { to = e.b + 1; while (text[to] === " " || text[to] === "\t") to++; }
      else {
        let q = from - 1;
        while (q > span[0] && /\s/.test(masked[q])) q--;
        if (masked[q] === ",") from = q;
      }
      anchor = { value: raw2, from, to };
    }
    if (hrefs > 1 || anchors > 1) return { fail: "a link object holds href or anchor more than once" };
    return { anchor, href };
  };
  /** @param {number} at @returns {ObjectInfo} */
  const objectAround = (at) => {
    const span = enclosingSpan(masked, at);
    return span === null ? { anchor: null } : parseObject(span[0]);
  };

  // ----- 4. Emit the links, pairing an anchor from the link's own object. --------------------------------
  for (const l of links) {
    if (l.kind === "template" || l.kind === "prose") { addUrl(l.url, l.at); continue; }
    const j = prevSig(l.s.start);
    const keyed = masked[j] === ":" && keyBefore(j) === "href";
    if (keyed && !l.url.includes("#")) {
      const r = objectAround(l.s.start);
      if ("fail" in r) { addUnresolved(l.s.start, r.fail); continue; }
      if (r.anchor) { addUrl(`${l.url}#${r.anchor.value}`, l.at, { from: r.anchor.from, to: r.anchor.to }); continue; }
    } else if (keyed) {
      const r = objectAround(l.s.start);
      if ("fail" in r) { addUnresolved(l.s.start, r.fail); continue; }
    }
    addUrl(l.url, l.at, l.edit);
  }
  // `href: CONST`.
  for (const m of masked.matchAll(/\bhref\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) {
    if (!docConsts.has(m[1])) continue;
    const url = /** @type {string} */ (docConsts.get(m[1]));
    const r = objectAround(m.index);
    if ("fail" in r) { addUnresolved(m.index, r.fail); continue; }
    if (r.anchor && !url.includes("#")) addUrl(`${url}#${r.anchor.value}`, m.index, { from: r.anchor.from, to: r.anchor.to });
    else addUrl(url, m.index);
  }
  // docLink({ ... }): its href must be a string literal or a known docs constant.
  for (const m of masked.matchAll(/\bdocLink\s*\(\s*\{/g)) {
    if (/\bfunction\s+$/.test(masked.slice(Math.max(0, m.index - 12), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const r = parseObject(open);
    if ("fail" in r) { addUnresolved(m.index, r.fail); continue; }
    if (!r.href) continue;
    if (stringAt.has(r.href.vAt)) continue;
    if (/^[A-Za-z_$][\w$]*$/.test(r.href.rest) && docConsts.has(r.href.rest)) continue;
    addUnresolved(m.index, "docLink href is not a string literal or a known docs constant");
  }
  // Helper calls: the first argument must be a string literal or a known docs constant.
  for (const h of HELPERS) {
    for (const m of masked.matchAll(new RegExp(`\\b${h}\\s*\\(\\s*`, "g"))) {
      if (/\bfunction\s+$/.test(masked.slice(Math.max(0, m.index - 12), m.index))) continue;
      const argAt = m.index + m[0].length;
      const s = stringAt.get(argAt);
      if (s && !s.dynamic) continue;
      const idm = /^[A-Za-z_$][\w$]*/.exec(masked.slice(argAt, argAt + 80));
      if (idm && docConsts.has(idm[0])) { addUrl(/** @type {string} */ (docConsts.get(idm[0])), m.index); continue; }
      addUnresolved(m.index, `${h}() first argument is not a string literal or a known docs constant`);
    }
  }
  // A docs constant exported to other modules cannot be followed there.
  for (const name of docConsts.keys()) {
    const esc = name.replace(/\$/g, "\\$");
    const inline = new RegExp(`\\bexport\\s+const\\s+${esc}(?![\\w$])`).exec(masked);
    if (inline) addUnresolved(inline.index, `${name} holds a docs link and is exported, so its uses in other modules cannot be resolved here`);
    for (const m of masked.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
      if (new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).test(m[1])) addUnresolved(m.index, `${name} holds a docs link and is exported, so its uses in other modules cannot be resolved here`);
    }
  }

  return { urls, unresolved };
}

const MAX_AMBIGUOUS_READINGS = 48;

/**
 * Scan `text` for docs.downpipes.io links. The file is read as the lexer's best guess says, and again with
 * each ambiguous "/" read the other way (see slashIsAmbiguous), and with all of them flipped. The links come
 * from the first reading. Anything another reading finds outside an allowed form is added to `unresolved`.
 * @param {string} text
 * @param {{ templateValues?: Record<string, string[]> }} [opts] templateValues: static URL prefix of a template literal -> every value its expression takes.
 * @returns {{ urls: DocLink[], unresolved: Unresolved[] }}
 */
export function scanDocLinks(text, opts = {}) {
  const lx = lex(text);
  if ("error" in lx) {
    return { urls: [], unresolved: [{ line: lineOf(text, lx.at), why: `the source could not be read to the end (${lx.error}), so its links cannot be graded` }] };
  }
  const main = scanReading(text, opts, lx);
  if (lx.ambiguous.length === 0) return main;
  const seen = new Set(main.unresolved.map((u) => `${u.line}:${u.why}`));
  /** @type {Array<"all" | Set<number>>} */
  const readings = ["all", ...lx.ambiguous.slice(0, MAX_AMBIGUOUS_READINGS).map((p) => new Set([p]))];
  if (lx.ambiguous.length > MAX_AMBIGUOUS_READINGS) {
    main.unresolved.push({ line: lineOf(text, lx.ambiguous[MAX_AMBIGUOUS_READINGS]), why: `this file has more than ${MAX_AMBIGUOUS_READINGS} slashes that could be a division or a regular expression, so not every reading was checked` });
  }
  for (const flip of readings) {
    const alt = lex(text, flip);
    if ("error" in alt) continue; // not a possible reading of this file
    const where = flip === "all" ? "every ambiguous" : `the ambiguous "/" on line ${lineOf(text, [...flip][0])}`;
    const r = scanReading(text, opts, alt);
    for (const u of r.unresolved) {
      const key = `${u.line}:${u.why}`;
      if (seen.has(key)) continue;
      seen.add(key);
      main.unresolved.push({ line: u.line, why: `if ${where} "/" is read the other way: ${u.why}` });
    }
    // A link the other reading finds is graded too.
    for (const u of r.urls) if (!main.urls.some((m) => m.url === u.url && m.line === u.line)) main.urls.push(u);
  }
  return main;
}

/** Every docs.downpipes.io URL in `text`, with the anchor from the href's own object literal appended. */
export function collectDocLinks(text, opts = {}) {
  return scanDocLinks(text, opts).urls.map((u) => u.url);
}

/**
 * What removing the anchor of one docs link, `url`, would change. Nothing is written. Each proposal is the
 * line number, the line as it is and the line as it would be after removing exactly the recorded span.
 * @returns {Array<{ line: number, before: string, after: string }>}
 */
export function proposeFix(text, url, opts = {}) {
  const proposals = [];
  const seen = new Set();
  for (const u of scanDocLinks(text, opts).urls) {
    if (u.url !== url || !u.edit || seen.has(u.edit.from)) continue;
    seen.add(u.edit.from);
    const lineStart = text.lastIndexOf("\n", u.edit.from - 1) + 1;
    let lineEnd = text.indexOf("\n", u.edit.to);
    if (lineEnd < 0) lineEnd = text.length;
    const before = text.slice(lineStart, lineEnd);
    const after = text.slice(lineStart, u.edit.from) + text.slice(u.edit.to, lineEnd);
    proposals.push({ line: u.line, before, after });
  }
  return proposals;
}
