#!/usr/bin/env bash
# Build the committed SPA bundle in CI's exact container. This is a CONVENIENCE, not a requirement: since
# `npm run build` on any platform emits the same bytes, and this script exists only for anyone
# who wants to see that confirmed against CI's own Node and npm before pushing.
#
# THE CLAIM THIS SCRIPT WAS BUILT ON WAS WRONG, and the correction is the point of the note. It said
# esbuild's output is not stable across operating systems, so a macOS build could never pass the drift
# guard. Re-measured on the same day: a macOS build of e4849f8 in a clean checkout with a fresh `npm ci`
# reproduces CI's Linux bytes exactly, all four artefacts, and the same holds at 95428e6 and at df5f3ef.
#
# The real input was the WORKING DIRECTORY. `--splitting` names the shared chunk chunk-<hash>.js, and
# esbuild folds each input module's path, printed relative to the process working directory, into that
# hash; `--minify` strips those paths back out of the emitted bytes. So the chunk ships identical byte for
# byte under a different name, and the drift guard, which compares the file-name set first, reads STALE
# against a bundle that is not stale. Measured at e4849f8: cwd = the package root gave chunk-MA456PI2.js
# (what CI emits), cwd = / gave chunk-6NXPUMYX.js, cwd = the parent gave chunk-Z7AETTQI.js, and a
# node_modules symlinked out of the repo gave chunk-2EYWJJXU.js, all four chunks byte-identical.
# scripts/stamp-build.mjs now chdirs to the package root and refuses a symlinked node_modules, and
# test/validate-bundle.ts builds a second time from another directory to keep that pinned.
#
# It still REFUSES rather than falling back to a host build, because a script named build-bundle-linux.sh
# that silently did not build on Linux would be lying about what it did. Use `npm run build` for a host
# build; that is now the supported path.
#
# --check WAS MUTATION-PROVED, and the first attempt is worth recording because it looked like a hole and
# was not. Appending an unused `export const` to src/lib/console-version.ts changed the source and --check
# still passed. That is CORRECT: esbuild tree-shakes an export nothing imports, so the emitted bytes really
# were identical and there was no drift to find. A side effect appended to the entry point src/app.ts
# cannot be tree-shaken, and --check then failed with "DRIFT: committed public/app.js differs from a fresh
# Linux build" and returned to passing on revert. So the teeth are in the emitted bundle, which is the
# thing that ships, rather than in the source text, which is not.
#
# Usage:
#   scripts/build-bundle-linux.sh            build into public/, ready to commit
#   scripts/build-bundle-linux.sh --check    build into a temp dir and byte-compare, writing nothing
#
# House style: Australian English, no em dashes, no rule-of-three, no AI attribution.
set -euo pipefail

IMAGE="node:22-bookworm"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-write}"

if [ "$MODE" != "write" ] && [ "$MODE" != "--check" ]; then
  echo "usage: $(basename "$0") [--check]" >&2
  exit 2
fi

if ! command -v docker > /dev/null 2>&1; then
  echo "FATAL: docker is not on PATH, so the bundle cannot be built on Linux." >&2
  echo "Building on this host would emit a bundle CI's drift guard rejects, so this refuses rather than" >&2
  echo "producing one that looks committable and is not." >&2
  exit 2
fi

if ! docker info > /dev/null 2>&1; then
  echo "FATAL: the docker daemon is not reachable, so the bundle cannot be built on Linux." >&2
  exit 2
fi

# npm ci inside the container, because node_modules on the host carries a platform-specific esbuild binary.
# --outdir is always a container temp dir; the write mode copies out only after the build has succeeded, so
# a failed build never leaves public/ half-written.
docker run --rm -v "${ROOT}:/w" -w /w "$IMAGE" bash -c '
  set -euo pipefail
  npm ci --no-audit --no-fund > /tmp/npm-ci.log 2>&1 || { echo "npm ci FAILED"; tail -20 /tmp/npm-ci.log; exit 1; }
  node scripts/stamp-build.mjs --outdir=/tmp/fresh
  rm -rf /w/.bundle-linux-out && mkdir -p /w/.bundle-linux-out
  cp /tmp/fresh/* /w/.bundle-linux-out/
'

OUT="${ROOT}/.bundle-linux-out"
trap 'rm -rf "$OUT"' EXIT

if [ "$MODE" = "--check" ]; then
  status=0
  for f in "$OUT"/*; do
    name="$(basename "$f")"
    if [ ! -f "${ROOT}/public/${name}" ]; then
      echo "DRIFT: a fresh Linux build emits ${name}, which is not committed under public/"
      status=1
    elif ! cmp -s "$f" "${ROOT}/public/${name}"; then
      echo "DRIFT: committed public/${name} differs from a fresh Linux build"
      status=1
    fi
  done
  # The reverse direction matters too: a committed artefact a fresh build no longer emits is stale, and
  # comparing only the fresh side would never notice it.
  for f in "${ROOT}"/public/*.js "${ROOT}"/public/__build.json; do
    name="$(basename "$f")"
    if [ ! -f "${OUT}/${name}" ]; then
      echo "DRIFT: committed public/${name} is NOT emitted by a fresh Linux build, so it is stale"
      status=1
    fi
  done
  if [ "$status" -eq 0 ]; then
    echo "the committed bundle matches a fresh Linux build, byte for byte"
  fi
  exit "$status"
fi

cp "$OUT"/* "${ROOT}/public/"
echo "public/ rebuilt on Linux. Commit public/*.js and public/__build.json with the source change."
