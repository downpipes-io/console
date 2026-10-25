// Plaintext refusal for the console Worker.
//
// The console serves the single-page app and one credential-bearing route: the licence claim-code POST.
// A request that arrives over http:// on a non-loopback host is never served. A GET or HEAD is sent to the
// https form of the same URL; any other method is refused, because the claim code in its body would already
// have crossed the network in clear. The loopback hosts are the wrangler dev seam and pass through.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** plaintextVerdict says what to do with a request whose URL scheme is http://: refuse, redirect, or nothing. */
export function plaintextVerdict(method: string, url: URL): "refuse" | "redirect" | null {
  if (url.protocol !== "http:" || LOOPBACK_HOSTS.has(url.hostname)) return null;
  return method === "GET" || method === "HEAD" ? "redirect" : "refuse";
}

export function plaintextRefusedResponse(): Response {
  return new Response(
    JSON.stringify({ error: "https required", detail: "This request arrived over plaintext http. The console is served over https only; open it at the https address." }),
    { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

export function plaintextRedirectResponse(url: URL): Response {
  return new Response(null, { status: 308, headers: { location: `https://${url.host}${url.pathname}${url.search}`, "cache-control": "no-store" } });
}
