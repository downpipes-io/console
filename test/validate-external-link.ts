// Validates the ASVS V3.7.3 external-link interstitial (src/lib/app-external-link.ts): the first-party
// allowlist that lets a downpipes.io / maelstrom.au link open directly (the tour welcome's "Privacy and
// cookies" link, src/lib/demo/tour/persona-fork.ts, is exactly this case), and the delegated click
// handler's full decision tree under the shared DOM shim -- same-origin, non-http(s) schemes, a
// malformed href, the modifier/non-primary-button guards, and a click landing on a DESCENDANT of the
// anchor rather than the anchor itself. Drives the REAL production code; never re-implements it.
//
// scripts/coverage-per-file-gate.mjs's own BASELINE names this file at 0% coverage ("Deliberately NOT
// exempt ... It should be the first one deleted from this list"). This suite is that deletion: once it
// lands, the BASELINE entry below the floor is removed in the same change.
// Run with `node test/validate-external-link.ts`.

import { docClick, dispatchDocKey, flushAsync, installDomShim } from "./dom-shim.ts";
import { makeChecks } from "./validate-checks.ts";

installDomShim();

const { _isFirstPartyHost, installExternalLinkInterstitial } = await import("../src/lib/app-external-link.ts");

const check = makeChecks();

// ===========================================================================
// 1. _isFirstPartyHost -- the allowlist predicate, in isolation
// ===========================================================================
console.log("-- _isFirstPartyHost (the allowlist) --");

check.ok("exact downpipes.io is first-party", _isFirstPartyHost("downpipes.io"));
check.ok("a downpipes.io subdomain is first-party", _isFirstPartyHost("docs.downpipes.io"));
check.ok("a nested downpipes.io subdomain is first-party", _isFirstPartyHost("a.b.downpipes.io"));
check.ok("exact maelstrom.au is first-party", _isFirstPartyHost("maelstrom.au"));
check.ok("a maelstrom.au subdomain is first-party", _isFirstPartyHost("www.maelstrom.au"));

// Negative controls: a naive `includes()` or unanchored suffix check would wrongly pass every one of
// these, which is exactly the class of bug an allowlist like this can hide.
check.ok("a look-alike host with NO dot boundary is NOT first-party", !_isFirstPartyHost("notdownpipes.io"));
check.ok("a prefixed look-alike is NOT first-party", !_isFirstPartyHost("evildownpipes.io"));
check.ok("downpipes.io as a SUFFIX of another domain is NOT first-party", !_isFirstPartyHost("downpipes.io.evil.com"));
check.ok("an unrelated host is NOT first-party", !_isFirstPartyHost("example.com"));
check.ok("an empty host is NOT first-party", !_isFirstPartyHost(""));

// ===========================================================================
// 2. installExternalLinkInterstitial -- the delegated click handler, end to end
// ===========================================================================
console.log("\n-- installExternalLinkInterstitial (delegated click handler) --");

installExternalLinkInterstitial();

function mountAnchor(href: string, opts: { child?: boolean } = {}): { clickTarget: Element } {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", href);
  anchor.target = "_blank";
  anchor.setAttribute("rel", "noopener noreferrer");
  let clickTarget: Element = anchor;
  if (opts.child) {
    const span = document.createElement("span");
    anchor.appendChild(span);
    clickTarget = span;
  }
  document.body.appendChild(anchor);
  return { clickTarget };
}

function overlayCount(): number {
  return document.querySelectorAll(".overlay").length;
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
}

// 2a. A first-party link (the tour welcome's privacy/cookies link, and its exact host) opens directly:
// no interstitial, defaultPrevented stays false (native target=_blank handling takes it).
{
  const { clickTarget } = mountAnchor("https://downpipes.io/cookies?src=tour-welcome");
  const before = overlayCount();
  const ev = docClick({ target: clickTarget });
  dispatchDocKey(ev);
  check.ok("first-party downpipes.io link: no interstitial mounted", overlayCount() === before);
  check.ok("first-party downpipes.io link: default NOT prevented (native new-tab handling)", ev.defaultPrevented === false);
}

// 2b. A first-party SUBDOMAIN (the marketing site could be served from any downpipes.io subdomain).
{
  const { clickTarget } = mountAnchor("https://docs.downpipes.io/guide");
  const before = overlayCount();
  dispatchDocKey(docClick({ target: clickTarget }));
  check.ok("first-party subdomain link: no interstitial mounted", overlayCount() === before);
}

// 2c. The parent company's own first-party host.
{
  const { clickTarget } = mountAnchor("https://maelstrom.au/");
  const before = overlayCount();
  dispatchDocKey(docClick({ target: clickTarget }));
  check.ok("first-party maelstrom.au link: no interstitial mounted", overlayCount() === before);
}

// 2d. A click landing on a CHILD of the anchor (an icon span, e.g. the "downpipes.io" link's external
// icon) still resolves via closest("a[href]") to the anchor -- and still exempts a first-party host.
{
  const { clickTarget } = mountAnchor("https://downpipes.io/pricing", { child: true });
  const before = overlayCount();
  const ev = docClick({ target: clickTarget });
  dispatchDocKey(ev);
  check.ok("click on a child of a first-party anchor resolves via closest() and is exempt", overlayCount() === before);
  check.ok("click on a child of a first-party anchor: default not prevented", ev.defaultPrevented === false);
}

// 2e. A same-origin link (an in-app anchor, however it ended up with target=_blank) is untouched --
// the same-origin guard runs before the allowlist and is unaffected by it.
{
  const { clickTarget } = mountAnchor("https://console.test/settings");
  const before = overlayCount();
  const ev = docClick({ target: clickTarget });
  dispatchDocKey(ev);
  check.ok("same-origin link: no interstitial mounted", overlayCount() === before);
  check.ok("same-origin link: default not prevented", ev.defaultPrevented === false);
}

// 2f. A non-http(s) scheme (mailto:) is left untouched regardless of host.
{
  const { clickTarget } = mountAnchor("mailto:support@downpipes.io");
  const before = overlayCount();
  const ev = docClick({ target: clickTarget });
  dispatchDocKey(ev);
  check.ok("mailto: link: no interstitial mounted", overlayCount() === before);
  check.ok("mailto: link: default not prevented", ev.defaultPrevented === false);
}

// 2g. Negative controls: hosts that must NOT match the allowlist still get the full warning.
const lookalikes: ReadonlyArray<readonly [string, string]> = [
  ["a look-alike host with no dot boundary", "https://notdownpipes.io/"],
  ["downpipes.io as a path/subdomain of another domain", "https://downpipes.io.evil.com/"],
  ["an unrelated third-party host", "https://example.com/"],
];
for (const [label, href] of lookalikes) {
  const { clickTarget } = mountAnchor(href);
  const before = overlayCount();
  const ev = docClick({ target: clickTarget });
  dispatchDocKey(ev);
  check.ok(`${label}: the interstitial DOES mount (not first-party)`, overlayCount() === before + 1);
  check.ok(`${label}: default IS prevented`, ev.defaultPrevented === true);
  // Dismiss via "Stay here" so the next case starts clean. handle.close() runs one microtask after
  // the click (runAction awaits the (synchronous) onClick before closing), hence the flush.
  findButton("Stay here")?.click();
  await flushAsync();
}

// 2h. A modifier-click (cmd/ctrl/shift/alt) or a non-primary mouse button is left to the browser's own
// handling, even against a third-party host -- the guard runs before the host is even looked at.
const guards: ReadonlyArray<{ metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; button?: number }> = [
  { metaKey: true },
  { ctrlKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
];
for (const opts of guards) {
  const { clickTarget } = mountAnchor("https://example.com/");
  const before = overlayCount();
  const ev = docClick({ target: clickTarget, ...opts });
  dispatchDocKey(ev);
  check.ok(`modifier/button guard ${JSON.stringify(opts)}: no interstitial mounted`, overlayCount() === before);
}

// 2i. An event whose default is already prevented (some earlier handler claimed the click) is a no-op:
// the interstitial must not ALSO act on it.
{
  const { clickTarget } = mountAnchor("https://example.com/");
  const before = overlayCount();
  const ev = docClick({ target: clickTarget });
  ev.preventDefault();
  dispatchDocKey(ev);
  check.ok("an already-prevented click is left alone", overlayCount() === before);
}

// 2j. A click whose target is not an Element at all (a bare text node) resolves to no anchor and must
// not throw.
{
  let threw = false;
  try {
    const text = document.createTextNode("plain text");
    dispatchDocKey(docClick({ target: text }));
  } catch {
    threw = true;
  }
  check.ok("a non-Element click target does not throw", !threw);
}

// 2k. A malformed href (fails URL parsing even against a base) is caught and left alone, not thrown.
{
  let threw = false;
  const { clickTarget } = mountAnchor("http://[::1");
  const before = overlayCount();
  try {
    dispatchDocKey(docClick({ target: clickTarget }));
  } catch {
    threw = true;
  }
  check.ok("a malformed href does not throw", !threw);
  check.ok("a malformed href does not mount the interstitial", overlayCount() === before);
}

// 2l. The confirm path still works for a genuine third party: "Open in a new tab" calls window.open
// with the destination and the safe rel; "Stay here" does not.
{
  const opened: unknown[][] = [];
  (globalThis as unknown as { open: (...a: unknown[]) => void }).open = (...args: unknown[]) => {
    opened.push(args);
  };

  const { clickTarget } = mountAnchor("https://example.com/report");
  dispatchDocKey(docClick({ target: clickTarget }));
  check.eq("third-party click mounts the interstitial", overlayCount(), 1);
  findButton("Open in a new tab")?.click();
  await flushAsync();
  check.eq("confirming opens exactly one new tab", opened.length, 1);
  check.eq("the new tab targets the clicked destination", opened[0]?.[0], "https://example.com/report");
  check.ok("the new tab carries noopener (ASVS V3.7.3: no reverse-tabnabbing handle)", String(opened[0]?.[2] ?? "").includes("noopener"));
  check.eq("the interstitial closes after the decision", overlayCount(), 0);

  // Cancel path: no second window.open call.
  const { clickTarget: clickTarget2 } = mountAnchor("https://example.com/report");
  dispatchDocKey(docClick({ target: clickTarget2 }));
  findButton("Stay here")?.click();
  await flushAsync();
  check.eq("cancelling opens NO new tab", opened.length, 1);
  check.eq("the interstitial closes on cancel too", overlayCount(), 0);
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(check.failures === 0 ? "\nEXTERNAL-LINK INTERSTITIAL VECTORS PASS" : `\n${check.failures} FAILURE(S)`);
if (check.failures > 0) process.exitCode = 1;
if (check.failures > 0) process.exit(1);
