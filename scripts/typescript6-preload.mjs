// FS-WRITES: none outside this repo
//
// Preloaded by `npm run lint:circular` (madge) and `npm run test:mutation` (StrykerJS) with
// node --import ./scripts/typescript6-preload.mjs, and nowhere else.
//
// madge parses .ts files through detective-typescript and @typescript-eslint/typescript-estree, which load the
// JavaScript compiler API with require("typescript"). The `typescript` package in this repo is TypeScript 7,
// whose root export carries only `version` and `versionMajorMinor`, so typescript-estree throws while it
// loads and madge exits before it reads a file. npm cannot give that subtree its own TypeScript 6: .npmrc
// sets legacy-peer-deps, so the peer edge is never placed and the parser resolves the hoisted package.
//
// StrykerJS core does the same: ts-config-preprocessor imports "typescript" and calls parseConfigFileTextToJson,
// and it declares no typescript dependency that an npm override could redirect.
//
// This hook sends the bare specifier "typescript" to @typescript/typescript6, the classic compiler API that
// the repo's own gates already import by name. It is registered only in the madge and Stryker processes. Every other
// specifier resolves as before.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typescript") return nextResolve("@typescript/typescript6", context);
    return nextResolve(specifier, context);
  },
});
