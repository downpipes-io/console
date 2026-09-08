// The external-link warning interstitial (ASVS V3.7.3), split out of the app entry (app.ts)
// as its own self-contained sibling: a single delegated click handler installed once at boot.

import { confirmModal } from "../components/modal.ts";

// FIRST_PARTY_HOSTS: hosts the warning does NOT apply to. ASVS V3.7.3 is about a link leaving the
// app's CONTROL, not about leaving this one origin -- downpipes.io (the marketing + docs site, linked
// from the tour welcome's privacy notice) and maelstrom.au (the parent company) are both
// downpipes-operated, so a link to either is not "an external site outside downpipes' control" and
// should open exactly like a same-origin link: directly, no interstitial. Every other origin still
// gets the warning below. Matched by exact host or a `.<host>` suffix, so `downpipes.io` covers
// `docs.downpipes.io` but never a look-alike like `notdownpipes.io` or `downpipes.io.evil.com`.
const FIRST_PARTY_HOSTS = ["downpipes.io", "maelstrom.au"];

export function _isFirstPartyHost(hostname: string): boolean {
  return FIRST_PARTY_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

// installExternalLinkInterstitial adds the EXTERNAL-LINK WARNING (ASVS V3.7.3): a delegated click handler
// that, before following a link OUT of the app (an external-origin target=_blank anchor), shows a confirm
// dialog naming the destination host. The new tab opens off the confirm-button gesture (confirmModal resolves
// on that click), so it is not popup-blocked; "Stay here" keeps the operator in the console. Non-http(s)
// schemes (mailto:, the recovery-sheet blob:), same-origin links and first-party hosts (FIRST_PARTY_HOSTS
// above) are left untouched, and a modifier-click (cmd/ctrl/shift) is left to the browser's own new-tab
// handling.
export function installExternalLinkInterstitial(): void {
  document.addEventListener("click", (ev: MouseEvent) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const start = ev.target;
    const anchor = start instanceof Element ? (start.closest("a[href]") as HTMLAnchorElement | null) : null;
    if (anchor?.target !== "_blank") return;
    let url: URL;
    try {
      url = new URL(anchor.getAttribute("href") ?? "", location.href);
    } catch {
      return;
    }
    if (url.origin === location.origin) return; // same-origin: an in-app link, no warning
    if (_isFirstPartyHost(url.hostname)) return; // downpipes.io / maelstrom.au (+ subdomains): no warning
    if (url.protocol !== "https:" && url.protocol !== "http:") return; // mailto:/blob: etc - leave untouched
    ev.preventDefault();
    void confirmModal({
      title: "Leaving downpipes",
      body: `This opens an external site, outside downpipes' control: ${url.host}. Continue?`,
      confirmLabel: "Open in a new tab",
      cancelLabel: "Stay here",
      variant: "danger",
    }).then((proceed) => {
      if (proceed) window.open(url.href, "_blank", "noopener,noreferrer");
    });
  });
}
