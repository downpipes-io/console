// Pre-loads this SPA's own code-split lazy chunks (multi-component updates P5). Sharp edge it closes: the
// bundle is built with esbuild --splitting, so the tour/demo subtree is a lazy chunk (demo-fetch-*.js)
// fetched only when first imported. A console update swaps the origin's assets to the NEW build, whose
// chunks have NEW content-hashed names, so the RUNNING (old) session's later dynamic import would 404
// mid-flight. The update flow therefore imports every lazy chunk BEFORE a console-including live apply,
// so the running session holds all its own code and cannot break between the asset swap and the reload.
//
// The import list must mirror app.ts's dynamic imports (today exactly one: the tour entry). Importing the
// module is side-effect free by design (app.ts imports it and then explicitly calls startDemo(); the
// module top level only defines), so preloading never starts the tour.

import { recordBootClass } from "./client-diag/ring.ts";

const CHUNK_LOADERS: ReadonlyArray<() => Promise<unknown>> = [
  () => import("./demo/demo-fetch.ts"),
];

// preloadOwnLazyChunks imports every lazy chunk, returning true when all loaded. A failed load is swallowed
// (false): preloading is a belt-and-braces protection, and a failure must never block the update the
// operator asked for (the post-apply reload prompt lands them on the new build regardless). Loaders are
// injectable for the validators; production callers use the default list.
//
// THE SWALLOW IS WHY THIS NEEDS A RECORD. The failure is deliberately not surfaced and deliberately not
// thrown, so when it happens the protection this module exists to give is simply gone and NOBODY KNOWS: the
// running session then holds a chunk it has not loaded, the apply renames the assets underneath it, and the
// operator's session breaks mid-update with a 404 on an import they never made. A boot-fault row of class
// `chunk-preload-failed` costs nothing, changes no behaviour, and lines up in the pack against the update the
// engine recorded at the same moment. The error itself is never read: the recorder takes no argument.
export async function preloadOwnLazyChunks(loaders: ReadonlyArray<() => Promise<unknown>> = CHUNK_LOADERS): Promise<boolean> {
  let allLoaded = true;
  for (const load of loaders) {
    try {
      await load();
    } catch {
      allLoaded = false;
    }
  }
  if (!allLoaded) recordBootClass("chunk-preload-failed");
  return allLoaded;
}
