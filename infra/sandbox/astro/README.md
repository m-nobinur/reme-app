# The Astro toolchain in the sandbox image

`/opt/astro` in the sandbox image is this directory with its `node_modules`
installed at image build time. A site in `/workspace` uses it by linking
rather than installing, so a build never reaches the registry:

```sh
ln -s /opt/astro/node_modules node_modules
```

The link is read-only, so a site's `astro.config.mjs` sets `vite.cacheDir` the
way this one does. A site's `package.json` has to name the same versions as
this one. A different version is a change to this directory, which rebuilds
the image on its own workflow.

The `@fontsource/*` packages are the site's fonts: the eight pairs in the
starter's `src/fonts.ts`, latin woff2 only, pinned exactly. A site with a
pair builds its files into `dist`; the image has no network for a font CDN and
the CSP allows none.

`src/pages/index.astro` is the one page the sandbox story measures
`astro build` against, and the probe route builds it on every run, so a broken
toolchain fails the probe rather than the first assignment.

`axe.mjs` is the accessibility gate's half that runs here: the build's tail
runs `node /opt/astro/axe.mjs dist /tmp/axe.json` and reports the exit code
(0 clean, 1 violations, 2 it could not run) and the JSON, which
`packages/gates/src/axe.ts` checks. It serves `dist/` on a free port and
drives the image's own Playwright and Chromium, loaded from the global
install because `/opt/astro` has no copy of them. `@axe-core/playwright` is
the one package of this directory that needs them at run time.
