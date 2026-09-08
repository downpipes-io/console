# Contributing to downpipes/console

The console is the in-account management GUI for the downpipes platform: onboarding, the
key ceremony, downpipe and source management, schedules, run status and the restore
drill. It runs in the customer's own Cloudflare account and talks ONLY to the in-account
engine admin API.

## Contributor Licence Agreement

Pull requests are accepted only from contributors who have signed the
[Contributor Licence Agreement](CLA.md). The CLA Assistant bot checks this automatically on your
first pull request and posts a comment with a sign-off link if you have not signed yet; signing
takes one comment and you only do it once.

## Non-negotiables

- No custody, no vendor inbound. The console never sends a key or customer data to the
  vendor. It calls the in-account engine only.
- The key ceremony generates the break-glass identity in the browser and the operator
  keeps the PRIVATE half offline; it is never uploaded to the engine or the vendor. Only
  the break-glass PUBLIC key (and the signer) go to the engine. The recovery sheet states
  this in plain language.
- Custom domains only. No `*.workers.dev`.
- Surface the cost truth: a high-frequency full re-read of a large KV namespace is the
  bill-shock risk; the schedule picker shows the projected cost and steers KV off hourly.

## Style

Australian English. The crypto in the key ceremony reuses the pinned
@noble/post-quantum and @noble/curves, in the same
byte encodings the engine and the Go offline tool use; `npm run validate:keygen` proves
the generated keys are well-formed and sound.

## Commits

Short, imperative, scoped subject lines, for example `keys: clear ceremony state on
sign-out`. Describe the change and the reason, not the process that produced it. Keep
each commit focused on one logical change so review and revert stay simple.

## Pull requests

Open a pull request against `main`. Before you push:

- run `npm run typecheck` and `npm run lint`;
- run `npm run validate` when you changed `src/` or `public/app.js` (the validator suite
  includes the CSP-hash and bundle-drift gates);
- rebuild the bundle if you touched `src/app.ts` or anything it imports, because the
  committed `public/app.js` is the artefact the worker serves;
- keep the change small and describe what it changes and why in the PR body.

Every push and pull request against `main` runs the CI workflow
(`.github/workflows/ci.yml`): type check, the validator suite, the bundle-drift gate
and a production-dependency `npm audit`. The `CI Success` check must pass before a
change can merge.

## Local hooks

`npm install` (or `npm ci`) runs the `prepare` script, which points git at the
repo-tracked `hooks/` directory (`git config core.hooksPath hooks`) instead of the
per-clone, untracked `.git/hooks/`. That is how a hook change reaches every clone: edit
`hooks/pre-commit` and commit it, and the next `npm install` picks it up everywhere.
`.git/hooks/pre-commit` is a leftover local-only copy on some clones and is not the
source of truth.

`hooks/pre-commit` blocks committing private-key material, and rebuilds and stages the
committed bundle (`public/*.js` and `public/__build.json`) when `src/`,
`public/tokens.css` or the `package*.json` lockfiles change. It stages the whole emitted
set, because a source change renames the content-hashed `chunk-<hash>.js` and staging the
entry alone would commit an `app.js` importing a chunk that is not in the tree. The hook
does not delete the renamed-away chunk; it names it, and you `git rm` it.

The build is platform-independent: esbuild folds each bundled module's path, printed
relative to the process working directory, into the `chunk-<hash>.js` name, and `--minify`
then strips those paths from the emitted bytes, so a build run from the wrong directory
would ship identical bytes under a different name and the drift gate would report STALE.
`scripts/stamp-build.mjs` pins that by chdir'ing to the package root and refusing a
`node_modules` symlinked out of the repo, and `test/validate-bundle.ts` builds a second
time from another directory to keep it pinned. The operating system is not an input.

## Developer Certificate of Origin

This project uses the Developer Certificate of Origin (DCO). Sign off every commit to
certify you wrote the change or have the right to submit it under the project licence:

```
git commit -s
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. Commits without a
sign-off are rejected.
