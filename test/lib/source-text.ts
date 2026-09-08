// Comment blanking, for a test that identifies a code construct by matching raw source text
// and needs comments (where the same shape appears in prose) blanked out first, while string
// literals stay intact (a hardcoded path or a CSP origin often lives inside one).
//
// Blanked, not removed: every comment byte becomes a space and every newline is kept, so the
// result has the same length and the same line breaks as the original, and an offset or a line
// number taken from the blanked text still points at the same place in the source.
//
// Quote and template aware, so a `//` inside a URL string or a `/*` inside a regex literal is
// not treated as a comment.
export function blankComments(src: string): string {
  const out = [...src];
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        // A single- or double-quoted string cannot span a newline; a template can.
        if (quote !== "`" && src[i] === "\n") break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    i++;
  }
  return out.join("");
}
