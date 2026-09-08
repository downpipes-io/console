// The training-mode FLAG, the tour-mode.ts pattern applied to the guided training walk.
// isTrainingMode is the cheap boot guard the genuine
// console evaluates on every page load; it reads only `location` and the in-file constants, with NO import
// of the demo/tour subtree, so app.ts imports it statically while the training walk itself loads through
// the same dynamic import that keeps the tour out of the default bundle.
//
// Training mode boots the SAME faked backend as the tour, with three differences the demo boot applies
// when this guard is true: the world starts at the training-start variant (a fresh account, the setup gate
// engaged, dual control off), the launcher is the task-gated training walk rather than the persona fork,
// and the walk's graders advance chapters only when the learner's own actions land in the world.
//
// House rules: Australian English, precise claims.

// TRAINING_FLAG is the URL query parameter that opts a DEV page load into the training walk (?training=1).
// Dev hosts only, exactly like ?tour=: the public deploy activates by hostname, so neither the genuine
// console nor the tour host can be coaxed into training mode by a crafted URL.
const TRAINING_FLAG = "training";

// TRAINING_HOSTS are the hostnames that serve the public training walk. training.downpipes.io is the
// owner's decided name (, free tier for everyone), deployed via wrangler.training.toml with
// the tour's own zero-server posture: nothing lives behind the hostname, the demo world is in the
// visitor's tab. Custom domains only, never a *.workers.dev address.
const TRAINING_HOSTS: ReadonlySet<string> = new Set(["training.downpipes.io"]);

// isDevHost mirrors tour-mode.ts's own: loopback names plus the *.local mDNS suffix, never a production
// host. Duplicated rather than imported so this module stays dependency-free for the static boot check
// (the two-line predicate is cheaper than a shared module both boot guards would pull in).
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

// isTrainingMode decides whether THIS page load is the guided training walk: a known training host (the
// production activation, dark until launch) or the ?training= flag on a local dev host. Any parse fault
// degrades to false (the genuine console), exactly as isTourMode does.
export function isTrainingMode(loc: Location = location): boolean {
  try {
    if (TRAINING_HOSTS.has(loc.hostname)) return true;
    return isDevHost(loc.hostname) && new URLSearchParams(loc.search).has(TRAINING_FLAG);
  } catch {
    return false;
  }
}
