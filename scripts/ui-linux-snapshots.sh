#!/usr/bin/env bash
# Regenerates the Linux visual baselines for packages/ui.
#
# The visual gate compares screenshots, and the same Chromium rasterises text
# differently on macOS and on Linux, so the baselines are kept per platform and
# CI compares against the Linux set. This produces that set on a developer
# machine, in the same image and architecture CI runs on, so the two agree.
#
# The tree is copied out first rather than mounted: the container installs its
# own node_modules, and Linux binaries written over the host's would break the
# next `pnpm dev`. Only the PNGs come back.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
image=mcr.microsoft.com/playwright:v1.62.1-noble
work=$(mktemp -d "${TMPDIR:-/tmp}/reme-snapshots.XXXXXX")
trap 'rm -rf "$work"' EXIT

rsync -a \
	--exclude node_modules --exclude .git --exclude .turbo \
	--exclude test-results --exclude playwright-report \
	"$root/" "$work/"

docker run --rm --platform linux/amd64 -v "$work":/work -w /work "$image" \
	bash -c 'corepack enable && pnpm install --frozen-lockfile --filter @workspace/ui && pnpm --filter @workspace/ui exec playwright test --update-snapshots'

rm -rf "$root/packages/ui/test/__screenshots__/linux"
cp -R "$work/packages/ui/test/__screenshots__/linux" \
	"$root/packages/ui/test/__screenshots__/linux"
echo "Linux baselines updated from $image"
