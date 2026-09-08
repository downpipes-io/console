#!/usr/bin/env bash
# Build the committed SPA bundle in CI's exact Linux container. This is a convenience, not a
# requirement: `npm run build` on any platform emits the same bytes, since scripts/stamp-build.mjs pins
# the working directory that would otherwise change esbuild's content-hash chunk names without changing
# their bytes. This script exists for anyone who wants to confirm that against CI's own Node and npm.
#
# It refuses rather than falling back to a host build, because a script named build-bundle-linux.sh that
# silently did not build on Linux would be lying about what it did. Use `npm run build` for a host build.
#
# Usage:
#   scripts/build-bundle-linux.sh            build into public/, ready to commit
#   scripts/build-bundle-linux.sh --check    build into a temp dir and byte-compare, writing nothing
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
