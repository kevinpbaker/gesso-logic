#!/usr/bin/env bash
#
# The install step for CI, which has no sibling Gesso checkout.
#
# Copied from gessosheet's `scripts/vercel-install.sh`.
#
# vendor/ is not committed — it is 2MB of tarballs that change on
# every engine iteration — so a fresh clone has no engine to build
# against. Locally `vendor-gesso.sh` packs one out of ../gesso; here
# there is no ../gesso, so this fetches the exact commit the last
# vendoring packed from, recorded in gesso.lock, and hands it to the
# same script. CI therefore runs the engine the
# working copy ran, and not whatever is on Gesso's main branch.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA="$(tr -d '[:space:]' < "$HERE/gesso.lock")"
GESSO="${TMPDIR:-/tmp}/gesso-$SHA"

if [ ! -d "$GESSO" ]; then
  echo "fetching gesso $SHA…"
  mkdir -p "$GESSO"
  git -C "$GESSO" init --quiet
  git -C "$GESSO" remote add origin https://github.com/kevinpbaker/gesso.git
  git -C "$GESSO" fetch --quiet --depth 1 origin "$SHA"
  git -C "$GESSO" checkout --quiet FETCH_HEAD
fi

echo "installing gesso's own dependencies…"
(cd "$GESSO" && pnpm install --frozen-lockfile)

# vendor-gesso.sh builds the packages, packs them under content
# hashes, rewrites package.json and pnpm-workspace.yaml to match, and
# installs. The rewrite is what the lockfile cannot survive: the
# hashes are a property of the bytes just built, so the committed
# lockfile names tarballs that no longer exist and pnpm, which will
# not move a lockfile under CI, stops with
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH on the `overrides` block.
#
# It has to be this flag and not NPM_CONFIG_FROZEN_LOCKFILE, which
# pnpm ignores. The env var read as a suggestion is why the first
# deploy failed and the second — packing, by luck, to the same hashes
# the lockfile already named — did not.
export PNPM_INSTALL_FLAGS=--no-frozen-lockfile
GESSO_REPO="$GESSO" bash "$HERE/scripts/vendor-gesso.sh"
