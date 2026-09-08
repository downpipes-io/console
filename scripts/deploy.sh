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
#   2. Blocking preflight: typecheck + validate + lint. With set -e any failure here
#      stops the deploy rather than shipping a broken or unvalidated bundle.
#   3. wrangler deploy.
#   4. Echo the deployed git SHA for provenance (match the bundle to a commit).
set -e
cd "$(dirname "$0")/.."

echo "Building the browser bundle (public/app.js)..."
npm run build

echo "Preflight: typecheck, validate, lint (a failure stops the deploy)..."
npm run typecheck
npm run validate
npm run lint

npx wrangler deploy

echo ""
echo "Deployed. Source revision: $(git rev-parse HEAD)"
