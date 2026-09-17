// Connection-specific request headers: the console Worker neither sends nor accepts them.
// A twin of engine/src/admin/connection-specific-guard.ts (the repos share no code).
//
// Hop-by-hop fields belong to one TCP connection and must not survive a proxy. The Cloudflare edge strips
// them on HTTP/2 and rejects transfer-encoding on HTTP/3 outright, but it forwards proxy-connection to the
// origin over HTTP/3. Nothing here reads that field, so it is inert, but a refusal is a control where a
// note is not: any request carrying one of these names is answered 400 before routing.
//
// "connection" is deliberately NOT in the set: the edge itself sets `connection: Keep-Alive` on every
// request it delivers to the origin, so refusing it would refuse all traffic. "te" is the one field a
// client may legitimately send end to end, and only with the exact value "trailers".
const REFUSED_NAMES: readonly string[] = ["transfer-encoding", "keep-alive", "upgrade", "proxy-connection"];

/** connectionSpecificHeaderRefusal names the offending header, or returns undefined when the request is clean. */
export function connectionSpecificHeaderRefusal(headers: Headers): string | undefined {
  for (const name of REFUSED_NAMES) if (headers.has(name)) return name;
  const te = headers.get("te");
  if (te !== null && te.trim().toLowerCase() !== "trailers") return "te";
  return undefined;
}
