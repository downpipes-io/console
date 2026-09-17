// functionBodies: every FUNCTION body in a TypeScript source, as [start, end) offsets, so a gate can ask
// "what is the smallest function containing this call" rather than guessing with a fixed line window.
//
// WHY NOT THE NEAREST BRACE BLOCK. The obvious version takes the innermost `{ ... }` around the call, and it
// is wrong in the direction that matters: a confirmModal inside an `if` or a `try` would be scoped to that
// block, and the write it confirms usually sits outside it. Scoping to the enclosing FUNCTION is what makes
// "this modal and this write are the same customer action" decidable without following call graphs.
//
// A brace opens a function body when it is preceded by `=>`, or by a `)` whose matching `(` is not a
// control-flow head (if / for / while / switch / catch), or by a TypeScript return-type annotation on such a
// `)`. Everything else (object literals, blocks, `try`, `else`) is not a function body. Strings and template
// literals are skipped, so a brace inside copy cannot unbalance the scan. Comments must be stripped by the
// caller (stripComments) before this runs.

const CONTROL_HEADS = new Set(["if", "for", "while", "switch", "catch", "with"]);

// nameBefore reads back from an opening paren for a readable label ("openRevokeModal", "onClick", or "" for
// an anonymous arrow). It is for the failure message only; nothing branches on it.
function nameBefore(src, parenOpen) {
  let j = parenOpen - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  let end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j])) j--;
  const word = src.slice(j + 1, end);
  if (word === "function" || word === "") {
    // `function name(` puts the name before the keyword's own position, so read one word further back.
    let k = j;
    while (k >= 0 && /\s/.test(src[k])) k--;
    end = k + 1;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    const prev = src.slice(k + 1, end);
    return prev === "" ? word : prev;
  }
  return word;
}

// matchParenBack returns the index of the `(` matching the `)` at `close`, or -1.
function matchParenBack(src, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = src[i];
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// matchQuoteBack returns the index of the quote OPENING the string that ends at `close`, or -1. It exists
// for STRING-LITERAL TYPES in a return-type annotation, which are ordinary source text to a scan reading
// backwards. A preceding backslash means the quote is escaped and the string continues further back.
function matchQuoteBack(src, close) {
  const q = src[close];
  for (let i = close - 1; i >= 0; i--) {
    if (src[i] === q && src[i - 1] !== "\\") return i;
  }
  return -1;
}

// matchBraceBack returns the index of the `{` matching the `}` at `close`, or -1.
function matchBraceBack(src, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = src[i];
    if (c === "}") depth++;
    else if (c === "{") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// opensFunction decides whether the `{` at `brace` opens a function body, and returns its label or null.
function opensFunction(src, brace) {
  let j = brace - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return null;
  if (src[j] === ">" && src[j - 1] === "=") return { name: "" };

  // A BRACE IN TYPE POSITION IS NOT A FUNCTION BODY, and this is the false positive that sits alongside the
  // three false negatives below. `): Promise<{ authExtras: AuthExtras }> {` has TWO braces, and the scan back
  // from the object type's own `{` reaches the same `:` and `)` the real one does, so the type was scored as
  // a body of its own. Harmless in the common case (a type contains no call sites) and not harmless in
  // principle: innermostContaining returns the SMALLEST body containing an index, so a spurious small body is
  // exactly the thing that can capture one. `<`, `|`, `&` and `,` immediately before a brace only ever open a
  // type member or an element of a literal; a function body's brace is never preceded by any of them.
  if (src[j] === "<" || src[j] === "|" || src[j] === "&" || src[j] === ",") return null;

  // A TypeScript return-type annotation sits between the `)` and the `{`: `): Promise<void> {`. Skip back
  // over the type expression to the colon, then to the `)`. The type may itself contain braces
  // (`): Promise<{ authExtras: AuthExtras; stepUp: Response | null }> {`), and stopping at one of those
  // would put the function's own opening brace outside any recognised function body, so a call inside it
  // would read as belonging to no function at all. A `}` here is jumped back over to its match rather than
  // ending the scan.
  //
  // A RETURN TYPE MAY ALSO BE A FUNCTION TYPE, `): () => Promise<boolean> {`, so the `=` of that arrow must
  // be stepped over rather than treated as ending the scan. A handler that returns a handler (for example
  // notifications/rule-form.ts's submitRuleForm) is a common enough shape in this codebase that this case
  // is not rare, and every gate that asks "which function contains this call" needs an answer for it. The
  // `=` is stepped over only when it is the arrow's own `=>`, so a genuine assignment still ends the scan.
  if (src[j] !== ")") {
    let k = j;
    for (;;) {
      while (k >= 0 && /[A-Za-z0-9_$<>|&,[\].;\s]/.test(src[k])) k--;
      if (k >= 0 && src[k] === "}") {
        k = matchBraceBack(src, k) - 1;
        if (k < -1) return null;
        continue;
      }
      if (k >= 0 && src[k] === "=" && src[k + 1] === ">") {
        k--;
        continue;
      }
      // The arrow's own parameter list, `(): () => Promise<boolean> {`. It is jumped back over the same way
      // the brace is. This cannot swallow the FUNCTION's parameter list by mistake: that one is only ever
      // reached after the `:` below, and the scan stops at the `:` first on every ordinary `): void {`.
      if (k >= 0 && src[k] === ")") {
        const open = matchParenBack(src, k);
        if (open < 0) return null;
        k = open - 1;
        continue;
      }
      // A RETURN TYPE MAY ALSO CONTAIN A STRING-LITERAL TYPE, `): Promise<"ok" | "signed-out"> {`, so a
      // closing quote here must be jumped back over to its opening quote, exactly as a brace is jumped back
      // to its match: otherwise the quote would end the scan and leave the whole body outside any
      // recognised function (restore-flow/batch.ts's dryRunOne has exactly this signature). Discriminated
      // unions of string literals are a common pattern in this codebase, so this case is not rare. A body
      // nothing can see here is graded by every gate built on this file as an anonymous handler, with
      // nothing to flag that it happened, which is why getting this case right matters beyond any one file.
      if (k >= 0 && (src[k] === '"' || src[k] === "'")) {
        const open = matchQuoteBack(src, k);
        if (open < 0) return null;
        k = open - 1;
        continue;
      }
      break;
    }
    if (k < 0 || src[k] !== ":") return null;
    k--;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0 || src[k] !== ")") return null;
    j = k;
  }

  const open = matchParenBack(src, j);
  if (open < 0) return null;
  let w = open - 1;
  while (w >= 0 && /\s/.test(src[w])) w--;
  const end = w + 1;
  while (w >= 0 && /[A-Za-z0-9_$]/.test(src[w])) w--;
  const word = src.slice(w + 1, end);
  if (CONTROL_HEADS.has(word)) return null;
  return { name: nameBefore(src, open) };
}

export function functionBodies(src) {
  const out = [];
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "{") {
      stack.push({ at: i, fn: opensFunction(src, i) });
    } else if (c === "}") {
      const s = stack.pop();
      if (s?.fn) out.push({ start: s.at, end: i + 1, name: s.fn.name, body: src.slice(s.at, i + 1) });
    }
  }
  return out;
}

// innermostContaining returns the SMALLEST function body from `bodies` that contains `index`, or null.
export function innermostContaining(bodies, index) {
  let best = null;
  for (const b of bodies) {
    if (b.start > index || index >= b.end) continue;
    if (best === null || b.end - b.start < best.end - best.start) best = b;
  }
  return best;
}
