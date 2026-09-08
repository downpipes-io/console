// The tour-mode FLAG, deliberately split out from demo-fetch.ts into its own dependency-free module.
// isTourMode is the cheap boot guard the genuine console evaluates on
// EVERY page load to decide whether this is the faked public tour; it reads only `location` and a pair of
// in-file constants, with NO import of the heavy tour subtree (the demo engine, the tour director/overlay,
// the welcome card, the Northwind seed, the banner, the analytics). Keeping it here lets app.ts import only
// this guard statically while loading the side-effectful startDemo() (and everything it pulls in) through a
// dynamic import inside the guard, so esbuild's code-splitting keeps the whole tour out of the default
// bundle the real console.downpipes.io ships and only fetches the tour chunk on tour.downpipes.io / ?tour=.
//
// House rules: Australian English, precise claims.

// TOUR_FLAG is the URL query parameter that opts a page load into the faked tour (e.g. ?tour=1). It is the
// dev/local trigger ONLY (see isDevHost): the public deploy turns the tour on by hostname (TOUR_HOSTS below),
// so the genuine console on its normal host is byte-for-byte unaffected and CANNOT be coaxed into the faked
// tour by a crafted ?tour= URL. The value is not parsed beyond presence.
const TOUR_FLAG = "tour";

// TOUR_HOSTS are the hostnames that serve the public faked tour. tour.downpipes.io is the decided public
// custom domain (no Cloudflare Access policy, no engine binding); demo.downpipes.io stays the Access-gated
// real engine demo and is deliberately NOT in this set. Custom domains only, never a *.workers.dev address.
const TOUR_HOSTS: ReadonlySet<string> = new Set(["tour.downpipes.io"]);

// isDevHost decides whether THIS host is a local development host where the ?tour= query opt-in is honoured.
// It is the loopback names (localhost, 127.0.0.1, ::1, and any *.localhost subdomain) plus the *.local mDNS
// suffix. It deliberately does NOT include any production host: the production console (console.downpipes.io),
// the Access-gated real engine demo (demo.downpipes.io) and the public tour host (tour.downpipes.io) are all
// false here, so the ?tour= flag activates the faked backend ONLY on a developer's own machine, never on a
// real deployment. The public tour reaches production solely via the hostname trigger (TOUR_HOSTS).
function isDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  );
}

// isTourMode decides whether THIS page load is the faked public tour. It is true when the host is a known
// tour host (the production activation) OR the tour query flag is present AND the host is a local dev host
// (the dev opt-in). The query flag is scoped to dev hosts so a crafted ?tour= link on the real console
// (console.downpipes.io) or the Access-gated demo can NEVER make a trusted production origin render the
// faked, mostly-green tour. It reads only location (no network, no storage) and is safe to call before boot.
// Any parse fault degrades to false (the genuine console), so a malformed URL never accidentally fakes the
// backend on a real deployment. It pulls in NO tour module, so the genuine console's bundle stays free of
// the tour subtree (which app.ts loads lazily through a dynamic import, only once this returns true).
export function isTourMode(loc: Location = location): boolean {
  try {
    if (TOUR_HOSTS.has(loc.hostname)) return true;
    return isDevHost(loc.hostname) && new URLSearchParams(loc.search).has(TOUR_FLAG);
  } catch {
    return false;
  }
}
