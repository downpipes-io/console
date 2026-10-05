#!/bin/sh
# Guided deploy (npm run deploy) for the console.
#
# The console is a static-bundle Worker: it serves the in-browser app and proxies
# to the engine. It holds NO console-attached source bindings of its own, so unlike
# the engine deploy there is no binding reconcile to run; `wrangler deploy` ships the
# bundle and the routes from wrangler.toml as-is.
#
# Order:
#   1. Build the browser bundle (public/app.js) so the deploy ships current code.
#   2. Blocking preflight, with set -e so any failure stops the deploy:
#        dependencies       node_modules matches package-lock.json (npm run lint:deps-installed)
#        typecheck          the app, the tests and the scripts compile
#        validate:customer  the checks that guard your keys in the browser
#   3. wrangler deploy.
#   4. Echo the deployed git SHA for provenance (match the bundle to a commit).
#
# THIS IS THE CUSTOMER PREFLIGHT, NOT THE DEVELOPER CHAINS. `npm run validate` and `npm run lint`
# compare this repo with the engine, docs, and other checkouts beside it, and some
# members refuse when the engine beside it is behind its own origin/main. A customer deploys a
# release tag in both repos, and a release tag is behind main as soon as anything lands after it,
# so those chains refused a customer deploy that followed /deploy. What a customer deploy must
# prove is that THIS tree is intact and deployable on THIS machine; CI ran the developer chains on
# the same commit. They are unchanged and stay exactly as strict.
#
# validate:customer runs the members that guard the customer's keys in the browser: key
# generation, capsule and envelope opening, splitting and reassembly, the in-console break-glass
# restore and prune, the recovery sheet, the committed bundle, and the Worker's security headers
# and CSP that protect the page holding the key. Every member left out is named, with a one-line
# reason, in scripts/customer-preflight.json, and test/validate-customer-preflight.ts fails when a
# developer-chain member is not classified there.
#
# HOW LONG IT TAKES, MEASURED on a fresh clone of the public export of this change, checked out at a
# release tag: dependencies 1 s, typecheck 13 s, validate:customer 60 s, 75 s in all after the build, on a
# machine at load average 95 to 110. On the same machine and load the developer chains it replaces ran for
# 624 s in validate alone and then refused. At load average 15 to 30 it took 36 s (dependencies under 1 s,
# typecheck 4 s, validate:customer 32 s).
set -e
cd "$(dirname "$0")/.."

echo "Building the browser bundle (public/app.js)..."
npm run build

echo "Preflight: dependencies, typecheck and the checks that guard your keys (a failure stops the deploy)."
echo "It took 36 to 75 seconds when measured, at load averages from 15 to 110."
npm run lint:deps-installed
npm run typecheck
npm run validate:customer

npx wrangler deploy

echo ""
echo "Deployed. Source revision: $(git rev-parse HEAD)"
