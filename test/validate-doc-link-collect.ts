// Validate the doc-link scanner (scripts/doc-link-collect.mjs, used by scripts/verify-doc-links.mjs).
//
// Grades every docs.downpipes.io link form the collector finds; each planted form below
// must make the gate fail and pass with a good anchor.
//
// The scanner is a fail-closed allowlist. Every occurrence of "downpipes.io" in a source file is accounted
// for by one allowed form (a complete link written as one plain string, the helpers with plain literal
// arguments, a comment, or a sentence), or the gate fails with file:line. The planted forms cover
// constants, concatenation, templates, escapes, encodings, letter case, folding characters, bindings,
// nested and shorthand anchors, object spreads and ambiguous slashes. The per-line reader passes each
// planted case; the gate fails it.
//
// Run with `node test/validate-doc-link-collect.ts`.

import { readFileSync } from "node:fs";
import { collectDocLinks, isSkippedDir, isSourceFile, proposeFix, scanDocLinks } from "../scripts/doc-link-collect.mjs";
import { verdictReached } from "./lib/verdict-guard.ts"; // ARMS the completion guard: see test/lib/verdict-guard.ts

let failures = 0;
function ok(label: string, cond: boolean): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
}

// The per-line reader: the comparison every planted case is graded against.
function collectPerLine(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const anchorM = /anchor:\s*"([^"]+)"/.exec(line);
    for (const h of line.matchAll(/href:\s*"(https:\/\/docs\.downpipes\.io\/[^"]+)"/g)) {
      let url = h[1] as string;
      if (anchorM && !url.includes("#")) url += `#${anchorM[1]}`;
      out.push(url);
    }
  }
  return out;
}

const BS = String.fromCharCode(92); // one backslash, written this way so no tool rewrites an escape in this file
const TICK = String.fromCharCode(96); // one backtick
const DB = String.fromCharCode(36, 123); // "${", the start of a template expression, kept out of plain strings
const BAD = "no-such-heading";
const GOOD = "the-real-heading";
const HEADINGS = new Set([GOOD]);
const graded = (url: string): boolean => {
  const anchor = new URL(url).hash.replace(/^#/, "");
  return anchor === "" || HEADINGS.has(anchor);
};
// The gate's verdict on one source text: FAIL when anything is unresolved or any anchor is not a heading.
function gateFails(text: string, templateValues?: Record<string, string[]>): boolean {
  const scan = scanDocLinks(text, templateValues ? { templateValues } : {});
  return scan.unresolved.length > 0 || !scan.urls.every((u) => graded(u.url));
}
const urlsOf = (text: string): string => collectDocLinks(text).join();

console.log("(1) allowed forms are collected and graded");
const L = (path: string) => `https://docs.downpipes.io/${path}`;
ok("a double-quoted link", urlsOf(`x("${L("a/b")}");`) === L("a/b"));
ok("a single-quoted link", urlsOf(`x('${L("a/b")}');`) === L("a/b"));
ok("a template link with no expression", urlsOf(`x(${TICK}${L("a/b")}${TICK});`) === L("a/b"));
ok("a link with its own #fragment", urlsOf(`x("${L("a/b#c")}");`) === L("a/b#c"));
ok("a const link", urlsOf(`const DOC = "${L("a/b")}";`) === L("a/b"));
ok("a link as an array element", urlsOf(`const a = ["${L("a/b")}", "${L("a/c")}"];`) === `${L("a/b")},${L("a/c")}`);
ok("a link in a return", urlsOf(`function f() { return "${L("a/b")}"; }`) === L("a/b"));
ok("a link in an arrow body", urlsOf(`const f = () => "${L("a/b")}";`) === L("a/b"));
ok("a link as an object value", urlsOf(`const o = { url: "${L("a/b")}", n: 1 };`) === L("a/b"));
ok("a link in JSON", urlsOf(`{ "guide": "${L("a/b")}" }`) === L("a/b"));
ok("groupDocLink with a plain literal", urlsOf(`sec.appendChild(groupDocLink("${L("a/b#c")}", "About"));`) === L("a/b#c"));
ok("a good link passes the gate, a bad anchor fails it", !gateFails(`x("${L(`a/b#${GOOD}`)}");`) && gateFails(`x("${L(`a/b#${BAD}`)}");`));
ok("a comment holding the host is not a link", urlsOf(`// see ${L(`a/b#${BAD}`)}\n/* docs.downpipes.io */\nconst a = 1;`) === "" && !gateFails(`// see ${L("a/b")}\nconst a = 1;`));
const TPLV = { "https://docs.downpipes.io/integrations/": ["x", "y"] };
const TPL = `export function f(v) {\n  return ${TICK}https://docs.downpipes.io/integrations/${DB}v.slug}${TICK};\n}`;
ok("the catalogue template expands to each registered value", collectDocLinks(TPL, { templateValues: TPLV }).join() === `${L("integrations/x")},${L("integrations/y")}`);
ok("the same template with no value list FAILS", gateFails(TPL));
ok("a template with another prefix FAILS even with a list", gateFails(TPL.replace("integrations", "other"), TPLV));
ok("a template with text after the expression FAILS", gateFails(TPL.replace("}`", "}/more`"), TPLV));

console.log("(2) other domains and sentences are not links");
const OTHER = [
  `const a = "support@downpipes.io";`,
  `const a = "https://downpipes.io/roles";`,
  `const a = "https://tour.downpipes.io/admin/x";`,
  `const a = ${TICK}https://tour.downpipes.io/admin/${DB}id}${TICK};`,
  `const a = "Visit downpipes.io for more";`,
  `const a = "console.downpipes.io";`,
  `const a = "https://control.downpipes.io";`,
  `const a = "downpipes.io";`,
  `// docs.downpipes.io lives here`,
];
for (const src of OTHER) ok(`passes: ${src.slice(0, 50)}`, !gateFails(src) && urlsOf(src) === "");
const PROSE = [
  `const a = "The documentation site, docs.downpipes.io. It has guides.";`,
  `const a = "Read it at https://docs.downpipes.io for the full guide";`,
  `const a = "docs.downpipes.io hosts the guide";`,
  "const a = `Visit docs.downpipes.io now`;",
  `const a = { blurb: "The site is docs.downpipes.io" };`,
];
for (const src of PROSE) ok(`a sentence passes: ${src.slice(0, 50)}`, !gateFails(src) && urlsOf(src) === "");
ok("a sentence with a /path grades the path", urlsOf(`const a = "Token scopes: docs.downpipes.io/operations/x#${BAD}";`) === L(`operations/x#${BAD}`) && gateFails(`const a = "Token scopes: docs.downpipes.io/operations/x#${BAD}";`));

console.log("(3) every way of hiding the host FAILS; the per-line reader passes each");
const HIDDEN: Array<[string, string]> = [
  // Constants, concatenation and templates.
  ["string concatenation", `const u = "https://docs." + "downpipes.io" + "/a/b#${BAD}";`],
  ["host split before the dot", `const u = "https://docs" + ".downpipes.io" + "/a/b#${BAD}";`],
  ["template over a host constant", `const BASE = "https://docs.downpipes.io";\nconst u = ${TICK}${DB}BASE}/a/b#${BAD}${TICK};`],
  ["host constant plus path", `const BASE = "https://docs.downpipes.io";\nconst u = BASE + "/a/b#${BAD}";`],
  ["scheme + host constant + path", `const HOST = "docs.downpipes.io";\nconst u = "https://" + HOST + "/a/b#${BAD}";`],
  ["template with a literal in its expression", `const u = ${TICK}https://docs.downpipes.io${DB}"/a/b#${BAD}"}${TICK};`],
  ["array join", `const u = ["https://docs.downpipes.io", "a"].join("/");`],
  ["array join over a constant", `const H = "https://docs.downpipes.io";\nconst u = [H, "a"].join("/");`],
  ["new URL with a host base", `const u = new URL("/a/b", "https://docs.downpipes.io");`],
  ["host followed by a variable", `const u = "https://docs.downpipes.io" + path;`],
  ["host in a template with an expression", `const u = ${TICK}https://docs.downpipes.io${DB}p}${TICK};`],
  ["a bare host constant passed on", `const H = "https://docs.downpipes.io";\nfetchDoc(H);`],
  ["a property that holds the host", `const cfg = { docs: "https://docs.downpipes.io" };\nconst u = cfg.docs + "/a";`],
  ["host with a ternary", `const u = ok ? "${L("a/b")}" : "${L("a/c")}";`],
  ["host with ||", `const u = got || "${L("a/b")}";`],
  ["host with ??", `const u = got ?? "${L("a/b")}";`],
  ["host with as", `const u = "${L("a/b")}" as string;`],
  ["host chained onto", `const u = "${L("a/b")}".trim();`],
  ["host with !", `const u = !"${L("a/b")}";`],
  ["host plus a piece", `const u = "${L("a/b")}" + "x";`],
  ["a piece plus the host", `const u = "x" + "${L("a/b")}";`],
  // Letter case.
  ["upper-case host", `const u = "https://DOCS.Downpipes.IO/a/b#${BAD}";`],
  ["upper-case scheme", `const u = "HTTPS://Docs.downpipes.io/a/b#${BAD}";`],
  ["upper-case host, variable", `const u = "https://DOCS.downpipes.io" + p;`],
  ["upper-case host as a URL base", `const u = new URL("/a", "https://Docs.DownPipes.io");`],
  // Escapes and encodings.
  ["\\x2e", String.raw`const u = "https://docs\x2edownpipes.io/a/b#${BAD}";`],
  ["\\u002e", `const u = "https://docs${BS}u002edownpipes.io/a/b#${BAD}";`],
  ["\\u002E, upper-case hex", `const u = "https://docs${BS}u002Edownpipes.io/a/b#${BAD}";`],
  ["\\u{2e}", String.raw`const u = "https://docs\u{2e}downpipes.io/a/b#${BAD}";`],
  ["escaped slashes", String.raw`const u = "https:\/\/docs.downpipes.io\/a\/b#${BAD}";`],
  ["an escaped letter", String.raw`const u = "https://do\x63s.downpipes.io/a/b#${BAD}";`],
  ["an escape on a plain letter", String.raw`const u = "https://d\ocs.downpipes.io/a/b#${BAD}";`],
  ["percent-encoded dot", `const u = "https://docs%2Edownpipes.io/a/b#${BAD}";`],
  ["percent-encoded letter", `const u = "https://%64ocs.downpipes.io/a/b#${BAD}";`],
  ["percent-encoded host, bare", `const u = "%64ocs.downpipes.io/a/b#${BAD}";`],
  ["tab beside the host", String.raw`const u = "https://docs.downpipes.io\t/a/b#${BAD}";`],
  ["newline beside the host", String.raw`const u = "https://docs.downpipes.io\n/a/b#${BAD}";`],
  // Folding characters.
  ["ideographic full stop", `const u = "https://docs。downpipes.io/a/b#${BAD}";`],
  ["fullwidth full stop", `const u = "https://docs．downpipes.io/a/b#${BAD}";`],
  ["halfwidth ideographic full stop", `const u = "https://docs｡downpipes.io/a/b#${BAD}";`],
  ["fullwidth letters", `const u = "https://ｄｏｃｓ.downpipes.io/a/b#${BAD}";`],
  ["soft hyphen", `const u = "https://docs.down­pipes.io/a/b#${BAD}";`],
  ["zero-width space", `const u = "https://docs.downpipes​.io/a/b#${BAD}";`],
  ["word joiner", `const u = "https://docs.downpipes.io⁠/a/b#${BAD}";`],
  ["byte-order mark", `const u = "https://﻿docs.downpipes.io/a/b#${BAD}";`],
  ["combining grapheme joiner", `const u = "https://docs.downpipes͏.io/a/b#${BAD}";`],
  ["variation selector", `const u = "https://docs.downpipes️.io/a/b#${BAD}";`],
  ["mongolian free variation selector", `const u = "https://docs.downpipes᠋.io/a/b#${BAD}";`],
  // Sentences that hide a link.
  ["markup template", `const h = ${TICK}<a href="https://docs.downpipes.io${DB}p}">x</a>${TICK};`],
  ["host, variable, then prose", `const u = "https://docs.downpipes.io" + p + " (docs)";`],
  ["prose prefix, then a path variable", `const u = "Docs: https://docs.downpipes.io" + path;`],
  ["sentence template ending in an expression", `const u = ${TICK}see https://docs.downpipes.io${DB}p} for details${TICK};`],
  ["host split across pieces after prose", `const u = "See https://docs." + "downpipes.io";`],
  ["a sentence split and cut", `const u = "see docs.downpipes.io".split(" ")[1] + "/a/b#${BAD}";`],
  ["a sentence with a .replace() call", `const u = "see docs.downpipes.io".replace("see ", "") + "/a/b#${BAD}";`],
  ["a sentence assigned then extended", `let t = "see docs.downpipes.io";\nt += "/a/b#${BAD}";`],
  // Bindings that change.
  ["let link extended", `let t = "${L("a/b")}";\nt += "#${BAD}";`],
  ["var link reassigned", `var t = "${L("a/b")}";\nt = "${L("a/c")}";`],
  ["link assigned to a plain name", `let u;\nu = "${L(`a/b#${BAD}`)}";`],
  ["later declarator", `let a = 1, u = "docs.";\nu += "downpipes.io/a/b#${BAD}";`],
  ["host grown by a ternary", `let u = ok ? "docs." : "x";\nu += "downpipes.io/a/b#${BAD}";`],
  ["property grown in parts", `o.u = "docs.";\no.u += "downpipes.io/a/b#${BAD}";`],
  ["a default parameter", `function f(u = "${L("a/b")}") { return u; }`],
  ["a host constant exported", `export const DOCS_BASE = "https://docs.downpipes.io";\n`],
  ["a docs link constant exported", `export const GUIDE = "${L("a/b")}";\n`],
  ["a docs link constant listed in an export", `const H = "${L("a/b")}";\nexport { H };\n`],
  ["a docs link constant declared twice", `function a() { const D = "${L("a/b")}"; }\nfunction b() { const D = "z"; }`],
  // The lexer is not trusted.
  ["a mis-lexed slash swallowing the line", `const a = b++ / c; const u = "${L(`a/b#${BAD}`)}"; const d = e / f;`],
  ["an unterminated string", `const a = 1;\nconst b = "${L("a/b")};\n`],
  ["an unterminated template", `const a = 1;\nconst b = ${TICK}${L("a/b")}`],
  ["an unterminated block comment", `const a = 1;\n/* ${L("a/b")}`],
  ["the host in code outside any string", `const a = docs.downpipes.io;`],
  ["the host inside a regular expression", String.raw`const r = /docs\.downpipes\.io\/a/;`],
];
for (const [name, src] of HIDDEN) {
  ok(`${name}: the gate FAILS`, gateFails(src));
  ok(`${name}: the per-line reader passes it`, collectPerLine(src).every(graded));
}

console.log("(4) link objects: the anchor is paired only from a plain entry");
const OBJ = (inner: string) => `docLink({\n${inner}\n});`;
const H = `  href: "${L("a/b")}",`;
ok("an anchor entry is paired", urlsOf(OBJ(`${H}\n  anchor: "${BAD}",\n  label: "x"`)) === L(`a/b#${BAD}`));
ok("a bad anchor FAILS", gateFails(OBJ(`${H}\n  anchor: "${BAD}"`)));
ok("a good anchor passes", !gateFails(OBJ(`${H}\n  anchor: "${GOOD}"`)));
ok("anchor before href is paired", urlsOf(OBJ(`  anchor: "${BAD}",\n${H}`)) === L(`a/b#${BAD}`));
ok("a one-line object is paired", urlsOf(`docLink({ href: "${L("a/b")}", anchor: "${BAD}", label: "x" });`) === L(`a/b#${BAD}`));
ok("a single-quoted object is paired", urlsOf(`docLink({ href: '${L("a/b")}', anchor: '${BAD}' });`) === L(`a/b#${BAD}`));
ok("a comment between entries is allowed", urlsOf(OBJ(`${H} // the page\n  /* why */ anchor: "${BAD}", // heading\n  label: "x"`)) === L(`a/b#${BAD}`));
ok("a link with no anchor is the bare page", urlsOf(OBJ(`${H}\n  label: "x"`)) === L("a/b"));
ok("href with its own # keeps it", urlsOf(OBJ(`  href: "${L("a/b#own")}",\n  anchor: "other"`)) === L("a/b#own"));
const NESTED: Array<[string, string]> = [
  ["a nested meta object", OBJ(`${H}\n  meta: { anchor: "keep-me", size: 2 },\n  label: "x"`)],
  ["a nested object before href", OBJ(`  nav: { anchor: "keep-me" },\n${H}`)],
  ["an array of objects", OBJ(`  kids: [{ anchor: "keep-me" }],\n${H}`)],
];
for (const [name, src] of NESTED) {
  ok(`${name}: the nested anchor is not the link's`, urlsOf(src) === L("a/b"));
  ok(`${name}: the own anchor is the one graded`, urlsOf(src.replace(H, `${H} anchor: "${BAD}",`)) === L(`a/b#${BAD}`));
}
const TERN = OBJ(`${H}\n  label: ok ? foo.anchor : "keep-z"`);
ok("a ternary on a member named anchor is not the anchor", urlsOf(TERN) === L("a/b"));
const BADOBJ: Array<[string, string]> = [
  ["a spread", OBJ(`  ...base,\n${H}\n  anchor: "${GOOD}"`)],
  ["a spread after", OBJ(`${H}\n  ...more`)],
  ["a computed key", OBJ(`${H}\n  ["anchor"]: "${GOOD}"`)],
  ["a computed key by name", OBJ(`${H}\n  [anchor]: "${GOOD}"`)],
  ["a shorthand anchor", OBJ(`${H}\n  anchor,`)],
  ["a shorthand anchor, last", OBJ(`${H}\n  anchor`)],
  ["a quoted anchor key", OBJ(`${H}\n  "anchor": "${GOOD}"`)],
  ["a single-quoted anchor key", OBJ(`${H}\n  'anchor': '${GOOD}'`)],
  ["a quoted href key", OBJ(`  "href": "${L("a/b")}",\n  anchor: "${GOOD}"`)],
  ["an anchor joined from two pieces", OBJ(`${H}\n  anchor: "dead" + "x"`)],
  ["an anchor that is two literals", OBJ(`${H}\n  anchor: "x" + "y"`)],
  ["an anchor with ||", OBJ(`${H}\n  anchor: "" || "x"`)],
  ["an anchor cast with as", OBJ(`${H}\n  anchor: "x" as string`)],
  ["an anchor from a table", `const DOC = { a: { anchor: "${GOOD}" } };\n${OBJ(`${H}\n  anchor: DOC[p].anchor`)}`],
  ["an anchor from a variable", OBJ(`${H}\n  anchor: name`)],
  ["an anchor from a template with an expression", OBJ(`${H}\n  anchor: \`h-\${n}\``)],
  ["an anchor with an escape", OBJ(`${H}\n  anchor: "a\\x2db"`)],
  ["two anchors", OBJ(`${H}\n  anchor: "${GOOD}",\n  anchor: "${BAD}"`)],
  ["two hrefs", OBJ(`${H}\n  href: "${L("a/c")}"`)],
];
for (const [name, src] of BADOBJ) {
  ok(`${name}: UNRESOLVED`, scanDocLinks(src).unresolved.length >= 1);
  ok(`${name}: the gate FAILS`, gateFails(src));
}
const CONSTOBJ = `const D = "${L("a/b")}";\nx(docLink({ href: D, anchor: "${BAD}" }));`;
ok("href: CONST pairs the anchor", urlsOf(CONSTOBJ) === `${L("a/b")},${L(`a/b#${BAD}`)}`);
ok("href: CONST with a spread FAILS", gateFails(`const D = "${L("a/b")}";\nx(docLink({ ...o, href: D }));`));
ok("docLink with a variable href FAILS", gateFails(`docLink({ href: mystery, label: "l" });`));
ok("groupDocLink with a variable FAILS", gateFails(`groupDocLink(someUrl, "About");`));
ok("groupDocLink with a known constant is graded", [...new Set(collectDocLinks(`const D = "${L("a/b")}";\ngroupDocLink(D, "About");`))].join() === L("a/b"));
ok("a call that holds a docs object is not ambiguous", !gateFails(`const x = ok ? field({ doc: { href: "${L("a/b")}" } }) : h("b");`));

console.log("(5) --fix writes nothing and proposes only the recorded span");
const DEAD = "overview";
const NEIGHBOURS = [
  `const sel = document.querySelector("#${DEAD}");`,
  `const note = "see #${DEAD} for the layout";`,
  `const other = { anchor: "${DEAD}", size: 3 };`,
  `const ex = "https://example.com/p#${DEAD}";`,
].join("\n");
const KEYLINK = `docLink({ href: "${L("a/b")}", anchor: "${DEAD}", label: "x" });`;
const INLINE = `x("${L(`a/b#${DEAD}`)}");`;
for (const [name, link] of [["anchor key", KEYLINK], ["inline fragment", INLINE]] as Array<[string, string]>) {
  const src = `${NEIGHBOURS}\n${link}\n`;
  const copy = `${src}`;
  const props = proposeFix(src, L(`a/b#${DEAD}`));
  ok(`${name}: one proposal`, props.length === 1);
  ok(`${name}: the proposal drops the anchor`, props[0] !== undefined && !props[0].after.includes(DEAD) && props[0].before.includes(DEAD));
  ok(`${name}: the proposal keeps the page link`, props[0]?.after.includes(L("a/b")) === true);
  ok(`${name}: the input text is unchanged`, src === copy);
}
const LASTKEY = `docLink({\n  href: "${L("a/b")}",\n  anchor: "${DEAD}"\n});`;
const lk = proposeFix(LASTKEY, L(`a/b#${DEAD}`));
ok("an anchor written last is proposed with its neighbouring comma", lk.length === 1 && !lk[0]!.after.includes(DEAD) && lk[0]!.after.trim() === `href: "${L("a/b")}"`);
ok("a link with no recorded span gets no proposal", proposeFix(TPL, L("integrations/x"), { templateValues: TPLV }).length === 0);
const verifySrc = readFileSync(new URL("../scripts/verify-doc-links.mjs", import.meta.url), "utf8");
ok("verify-doc-links.mjs has no write path", !/writeFileSync|writeFile\(|appendFile|\.write\(|renameSync|unlinkSync|rmSync/.test(verifySrc));
const collectSrc = readFileSync(new URL("../scripts/doc-link-collect.mjs", import.meta.url), "utf8");
ok("doc-link-collect.mjs has no write path", !/writeFileSync|writeFile\(|appendFile|renameSync|unlinkSync|rmSync/.test(collectSrc));

console.log("(6) which files the gate reads");
for (const n of ["a.ts", "a.tsx", "a.mts", "a.mjs", "a.js", "a.cjs", "a.json"]) ok(`reads ${n}`, isSourceFile(n));
ok("skips .d.ts and .d.mts", !isSourceFile("a.d.ts") && !isSourceFile("a.d.mts"));
ok("skips .md and .css", !isSourceFile("a.md") && !isSourceFile("a.css"));
ok("skips node_modules at any depth", isSkippedDir("node_modules") && isSkippedDir("node_modules", true));
ok("skips dist and build at src's top level only", isSkippedDir("dist", true) && isSkippedDir("build", true) && !isSkippedDir("dist") && !isSkippedDir("build"));
ok("reads a normal folder", !isSkippedDir("screens"));

console.log("(6b) an ambiguous slash is read both ways");
const AMBIG: Array<[string, string]> = [
  ["a slash after a closing paren hides a quote", `if (ok) /"/.test(s); const D = { href: "${L("a/b")}" + "y" };`],
  ["the same with the link as a plain link", `if (ok) /"/.test(s); const D = { href: "${L(`a/b#${BAD}`)}" };`],
  ["a slash after ++ hides a quote", `i++ / 2; const D = { href: "${L("a/b")}" + "y" };`],
  ["a slash after a closing bracket", `const a = [1] / 2; const D = { href: "${L("a/b")}" + "y" };`],
  ["a slash after a closing brace", `function f() {}\n/"/.test(s); const D = { href: "${L("a/b")}" + "y" };`],
];
for (const [name, src] of AMBIG) ok(`${name}: the gate FAILS`, gateFails(src));
ok("a division on its own line is not a failure", !gateFails(`const a = (b + c) / 2;\nconst u = "${L(`a/b#${GOOD}`)}";`));
ok("a division with no docs host is not a failure", !gateFails(`const a = (b + c) / 2; const c = d / 3;`));
const amb = scanDocLinks(`if (ok) /"/.test(s); const D = { href: "${L("a/b")}" + "y" };`);
ok("the failure names the reading", amb.unresolved.some((u) => u.why.includes("read the other way")));

console.log("(6c) a substitution before the host");
const SUBST = [
  `${TICK}https://${DB}p}.downpipes.io/a/b${TICK}`,
  `${TICK}${DB}a}cs.downpipes.io/a/b${TICK}`,
  `${TICK}https://${DB}p}${DB}q}.downpipes.io/a/b${TICK}`,
  `${TICK}${DB}p}.downpipes.io${TICK}`,
  `${TICK}x${DB}p}downpipes.io/a${TICK}`,
  `${TICK}https://${DB}p}.docs.downpipes.io/a/b${TICK}`,
  `${TICK}${DB}p}.${TICK} + ${TICK}downpipes.io/a${TICK}`,
];
for (const t of SUBST) ok(`FAILS: ${t.slice(0, 44)}`, gateFails(`const u = ${t};`));
ok("a substitution after the host path is the registered form only", gateFails(`const u = ${TICK}https://docs.downpipes.io/a/${DB}p}/b${TICK};`));
ok("a substitution before another domain is not a failure", !gateFails(`const u = ${TICK}https://${DB}p}.tour.downpipes.io/a${TICK};`));

console.log("(6d) whitespace and control characters inside a link");
const CONTROL: Array<[string, string]> = [
  ["a raw tab in the path", `x("https://docs.downpipes.io/a\tb");`],
  ["a raw carriage return in the path", `x("https://docs.downpipes.io/a\rb");`],
  ["a raw tab between host and path", `x("https://docs.downpipes.io\t/a/b");`],
  ["a tab escape in the path", `x("https://docs.downpipes.io/a${BS}tb");`],
  ["a newline escape in the path", `x("https://docs.downpipes.io/a${BS}nb");`],
  ["a carriage return escape in the path", `x("https://docs.downpipes.io/a${BS}rb");`],
  ["a hex tab escape in the path", `x("https://docs.downpipes.io/a${BS}x09b");`],
  ["a hex tab escape between host and path", `x("https://docs.downpipes.io${BS}x09/a/b");`],
  ["a line continuation in the path", `x("https://docs.downpipes.io/a${BS}\nb");`],
  ["a line continuation inside the host", `x("https://docs.down${BS}\npipes.io/a/b");`],
  ["a tab in a sentence's link path", `x("see docs.downpipes.io/a\tb now");`],
  ["a tab escape in a sentence's link path", `x("see docs.downpipes.io/a${BS}tb now");`],
  ["a newline escape right after a sentence's host", `x("see docs.downpipes.io${BS}n/a/b");`],
  ["a non-ASCII letter in the path", `x("https://docs.downpipes.io/é");`],
];
for (const [name, src] of CONTROL) ok(`${name}: the gate FAILS`, gateFails(src));
ok("a plain space after a sentence's link path is still prose", !gateFails(`x("see docs.downpipes.io/a/b#${GOOD} for details");`) && urlsOf(`x("see docs.downpipes.io/a/b#${GOOD} for details");`) === L(`a/b#${GOOD}`));

console.log("(7) the stated limits are pinned so a change is seen");
const BASEL = `const BASE = "${L("a/b")}";\n`;
const BUILT: Array<[string, string]> = [
  ["a constant plus more text", `${BASEL}const u = BASE + "-x";`],
  ["a constant with replace", `${BASEL}const u = BASE.replace("a", "c");`],
  ["a constant with a template suffix", `${BASEL}const u = ${TICK}${DB}BASE}#${BAD}${TICK};`],
];
for (const [name, src] of BUILT) {
  const r = scanDocLinks(src);
  ok(`${name}: only the constant is graded`, r.unresolved.length === 0 && [...new Set(r.urls.map((u) => u.url))].join() === L("a/b"));
}
const OBFUSCATED: Array<[string, string]> = [
  ["an HTML entity for the dot", `x("https://docs&#46;downpipes.io/a/b#${BAD}");`],
  ["a multi-byte percent-encoding inside the host", `x("https://docs.down%C2%ADpipes.io/a/b#${BAD}");`],
  ["a control character inside the host", `x("https://docs.down${BS}x01pipes.io/a/b#${BAD}");`],
];
for (const [name, src] of OBFUSCATED) {
  const r = scanDocLinks(src);
  ok(`${name}: deliberately hidden host text is not decoded`, r.urls.length === 0 && r.unresolved.length === 0);
}
const NO_HOST_TEXT = `const u = "https://docs." + ["downpipes", "io"].join(".") + "/a/b#${BAD}";`;
const lim = scanDocLinks(NO_HOST_TEXT);
ok("a host with no host text is neither graded nor reported", lim.urls.length === 0 && lim.unresolved.length === 0);
const AFTER = `const o = { href: "${L("a/b")}", label: "x" };\no.href += "#${BAD}";`;
const af = scanDocLinks(AFTER);
ok("a link changed after it is built is not followed", af.unresolved.length === 0 && af.urls.map((u) => u.url).join() === L("a/b"));
ok("JSX markup fails closed as unreadable", scanDocLinks(`const el = <a href="${L("a/b")}">x</a>;\n`).unresolved.length === 1);

verdictReached(failures);
if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
