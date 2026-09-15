# The starter site fixture

The site the Developer restores into a fresh sandbox until Phase 2's
`packages/starter-site` exists (builder track N3, then N5). Two pages, one
layout, and `src/site-config.ts`, which every string on the site reads from.
An empty field renders nothing, so a missing fact is a missing section and
never a placeholder.

The versions in `package.json` match `infra/sandbox/astro/package.json`: the
sandbox image holds that toolchain at `/opt/astro`, and the Developer links
`node_modules` to it instead of installing.

Fictional throughout. When `packages/starter-site` lands, this directory is
deleted and the loader points at the package (N5).
