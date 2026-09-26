// The demo-route SIGNAL: a dependency-free listener registry that demo-fetch.ts notifies after each faked
// /admin/* request settles (its world mutation, including the read-driven run settlement, has happened).
// Split into its own module so the training walk's task graders (tour/director.ts) can subscribe without
// importing demo-fetch.ts, which imports the walk's launcher: the registry in either of those files would
// be an import cycle, and this two-function module is the seam that avoids one.
//
// House rules: Australian English, precise claims.

const routeListeners = new Set<() => void>();

// onDemoRoute subscribes a listener to the settled-request signal and returns its disposer, so a stale
// subscription cannot leak across training beats. Best-effort per listener: a throwing grader never breaks
// a fetch or the other listeners.
export function onDemoRoute(listener: () => void): () => void {
  routeListeners.add(listener);
  return () => routeListeners.delete(listener);
}

// notifyDemoRoute fires every listener; demo-fetch.ts calls it after each faked request settles, reads and
// writes alike (reads matter because the read-driven run settlement mutates the world on a history read).
export function notifyDemoRoute(): void {
  for (const listener of routeListeners) {
    try {
      listener();
    } catch {
      // A listener fault is its own problem; the fetch and the other listeners proceed.
    }
  }
}
