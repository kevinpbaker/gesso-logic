#!/usr/bin/env bash
#
# Re-pack the Gesso packages out of the sibling checkout into vendor/.
#
# Copied from gessosheet, where the loop was worked out. It exists
# because the README's advice — re-run `create-gesso-app
# --local --force` over this directory — also rewrites src/, README.md
# and package.json from the template, which would delete this project.
# Phase 0 expects to change the engine, so the loop has to be safe to
# run a hundred times.
#
#   ./scripts/vendor-gesso.sh              # build what is stale, then pack
#   ./scripts/vendor-gesso.sh --no-build   # pack whatever dist/ holds now
#   GESSO_REPO=/path/to/gesso ./scripts/vendor-gesso.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GESSO="${GESSO_REPO:-$(cd "$HERE/../gesso" 2>/dev/null && pwd || true)}"
PACKAGES=(core framework components devtools vite-plugin testing)

if [ -z "$GESSO" ] || [ ! -f "$GESSO/pnpm-workspace.yaml" ]; then
  echo "No Gesso checkout found. Set GESSO_REPO to point at one." >&2
  exit 1
fi

if [ "${1:-}" != "--no-build" ]; then
  filters=()
  for pkg in "${PACKAGES[@]}"; do filters+=(--filter "./packages/$pkg"); done
  echo "building ${PACKAGES[*]} in $GESSO…"
  (cd "$GESSO" && pnpm "${filters[@]}" build)
fi

echo "packing into vendor/…"
rm -rf "$HERE/vendor"
mkdir -p "$HERE/vendor"
for pkg in "${PACKAGES[@]}"; do
  (cd "$GESSO/packages/$pkg" && pnpm pack --pack-destination "$HERE/vendor" >/dev/null)
done

# Stamp each tarball with a hash of its own bytes.
#
# Without this the loop silently does nothing. pnpm resolves a `file:`
# tarball by its path and version and then trusts its store, so an
# engine change that leaves the version alone — which every change
# during a phase does — re-packs a new tarball under the old name and
# is never unpacked: `pnpm install` says "Already up to date" and the
# app keeps running the previous build. A content hash in the name
# makes every real change a new specifier, which is the only thing
# pnpm reliably notices.
for tarball in "$HERE"/vendor/*.tgz; do
  sum="$(sha256sum "$tarball" | cut -c1-8)"
  mv "$tarball" "${tarball%.tgz}-$sum.tgz"
done

# The tarball names carry the version, so a version bump in the
# workspace changes every specifier in package.json and
# pnpm-workspace.yaml. Rewrite both from what actually landed.
node - "$HERE" <<'NODE'
const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[2];
const tarballs = readdirSync(join(root, 'vendor')).filter(f => f.endsWith('.tgz'));
const spec = {};
for (const file of tarballs) {
  const name = file.replace(/-\d+\.\d+\.\d+.*\.tgz$/, '');
  spec[name] = `file:vendor/${file}`;
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'devDependencies', 'overrides']) {
  for (const name of Object.keys(manifest[field] ?? {})) {
    if (spec[name]) manifest[field][name] = spec[name];
  }
}
writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const lines = [
  '# The tarballs in vendor/ again, for pnpm.',
  '#',
  '# Written by scripts/vendor-gesso.sh. pnpm 11 reads overrides only',
  '# from this file, not from package.json.',
  'overrides:'
];
for (const [name, value] of Object.entries(spec)) lines.push(`  ${name}: ${value}`);
lines.push(
  '',
  '# The engine is exempt from the publish-age cooldown.',
  '#',
  "# pnpm will not install anything published in the last day — a good",
  '# rule, and malware is usually found inside it. It is the wrong rule',
  '# for these six: they are built from the checkout beside this one and',
  '# installed from the tarballs in vendor/, so the copy that lands here',
  '# is never the registry copy and waiting a day protects nothing. The',
  '# build rejected them the first afternoon 0.4.0 was published.',
  '#',
  '# The exemption is by name and only these names. Everything from the',
  '# registry keeps the cooldown, which is the part that was protecting',
  '# anything.',
  'minimumReleaseAgeExclude:'
);
for (const name of Object.keys(spec)) lines.push(`  - ${name}`);
writeFileSync(join(root, 'pnpm-workspace.yaml'), `${lines.join('\n')}\n`);
console.log(`vendored ${tarballs.length} packages`);
NODE

# Record which Gesso commit these tarballs came out of.
#
# vendor/ is not committed, so a build with no sibling checkout — the
# Vercel one, and any fresh clone — has to fetch the engine itself.
# This is the only thing that tells it *which* engine: the deployed
# build packs from the commit the working copy packed from, rather
# than from whatever Gesso's main branch has moved on to. A dirty
# checkout is packed all the same and said so, because the loop this
# script exists for is editing the engine and looking at the sheet;
# the stamp is then a near-miss and the warning is the honest part.
STAMP="$(git -C "$GESSO" rev-parse HEAD)"
echo "$STAMP" > "$HERE/gesso.lock"
if [ -n "$(git -C "$GESSO" status --porcelain)" ]; then
  echo "note: $GESSO has uncommitted changes; gesso.lock names its HEAD, which is not what was packed" >&2
fi

# And whether a deploy could fetch what was just stamped.
#
# vercel-install.sh clones that one commit from GitHub, so a
# gesso.lock naming a commit that was never pushed is a deploy that
# dies in two seconds on `upload-pack: not our ref` — twenty minutes
# later, in a log nobody is watching, with nothing in this repository
# to suggest why. That happened once, which is why this is here.
#
# A warning rather than a failure. The order is allowed to be wrong
# for a while: what has to be true is that Gesso is pushed before the
# commit carrying this gesso.lock is, not before this script ends. And
# a checkout with no network still has a sheet to run, so an origin
# that cannot be reached is said and stepped over.
if GIT_TERMINAL_PROMPT=0 git -C "$GESSO" fetch --quiet origin 2>/dev/null; then
  if [ -z "$(git -C "$GESSO" branch -r --contains "$STAMP" 2>/dev/null)" ]; then
    cat >&2 <<WARN

  WARNING: gesso $STAMP is on no remote branch.

  gesso.lock now names it, and the deploy fetches it from GitHub by
  that name alone. Push Gesso before you push the commit that carries
  this gesso.lock, or the build fails with "upload-pack: not our ref".

WARN
  fi
else
  echo "note: could not reach Gesso's origin; gesso.lock was not checked against it" >&2
fi

# The flags are the caller's, because CI needs one this does not.
# Empty here: locally `pnpm install` is exactly what is wanted.
cd "$HERE" && pnpm install ${PNPM_INSTALL_FLAGS:-}

# Drop Vite's pre-bundled copies of the old packages.
#
# The same failure as the tarball names, one layer up. Vite bundles
# each dependency once into node_modules/.vite and keys the cache on the
# lockfile, which an install does update — but a dev server already
# running goes on serving the copy it bundled, and a restart can reuse
# it. Phase 16 met this as "shell.saveFile is not a function": the new
# engine was installed and the page was still running the old one.
rm -rf "$HERE/node_modules/.vite"
echo "cleared Vite's dependency cache; restart any running dev server"
