// The serving worker's TOPOLOGY declaration, held as one boolean the transport can read.
//
// WHY A MODULE OF ITS OWN. The console runs in two topologies. In the DEFAULT (and the one every documented
// deploy uses) the console worker PROXIES the engine surface over an ENGINE service binding, so every browser
// call is same-origin and the engine is not reachable by HTTP at all from here. In the SPLIT topology the engine
// is a separate hostname the operator typed in. The serving worker declares which it is at /engine-topology.json
// and the store adopts it at boot (adoptProxiedTopology).
//
// The transport needs that fact to read a 5xx honestly. A SERVICE BINDING CANNOT ANSWER HTML: the engine's
// refusals are jsonError JSON and its unmatched route is plain text, so in the proxied topology a 5xx with an
// HTML body did not come from the engine. It is Cloudflare's own error page in front of the CONSOLE worker (over
// CPU or memory limits, script gone, an edge fault), and the console worker never ran, so it could not stamp its
// own fault header on it. Read as an engine 5xx, that page told support the engine saw the call and refused it,
// and sent them to read refusals in the engine's logs that cannot exist. In the SPLIT topology the same page is
// most often Cloudflare's 1101 in front of a REAL, BROKEN engine, so the claim cannot be made there and is not.
//
// This lives in a LEAF module because the store already imports the api client: the transport reading the store
// would close a cycle (madge is a gate). It holds no customer value, only the console's own deploy shape.
//
// It DEFAULTS TO FALSE, which is the conservative direction: an unknown topology keeps the old, engine-blaming
// reading rather than asserting a console-origin fault the console cannot prove.
let proxied = false;

export function setProxiedTopology(v: boolean): void {
  proxied = v;
}

// isEdgeHtmlFaultResponse is the ONE test both seams use for that page, and it lives here so they cannot drift
// apart. The response seam (noteEngineResponse) MAY NOT READ THE BODY -- a body can be read once and the
// transport must have it -- so the test is the CONTENT TYPE, a header, and the throw seam (failResponse) asks the
// same question rather than a second one of its own. Two seams that answered differently would put two
// contradicting rows in one pack, which is the trap the engine-binding-absent pair was built to avoid: an
// engine-call row saying the network dropped it beside a feature-probe row saying the engine refused it.
//
// It copies nothing out of the response: a substring test against a constant this repo ships, over a header.
export function isEdgeHtmlFaultResponse(r: Response): boolean {
  if (r.status < 500 || !proxied) return false;
  return (r.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}
