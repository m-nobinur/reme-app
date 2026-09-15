# The builder sandbox (ADR-031): a filesystem and a shell for the Developer,
# and nothing else. No key, token or connection string is baked in or handed
# in; the Worker holds those. Egress is decided by RemeSandbox in
# apps/orchestrator/src/cloudflare.ts, not here.
#
# The tag must equal the @cloudflare/sandbox version in
# apps/orchestrator/package.json: the SDK and the control server in the image
# speak one protocol per release. The digest pins what that tag resolved to on
# 2026-09-15. Bump the two together, and re-pin the digest.
FROM docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe

# Toolchain versions, checked against npm on 2026-09-15.
ARG PNPM_VERSION=10.33.4
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

# pnpm, and Playwright with the headless Chromium shell plus its system
# libraries: screenshots need no windowed browser. The browsers live under
# /opt so every user can read them and no user can write them. The base
# image keeps apt's download cache on purpose; this image does not.
RUN npm install -g pnpm@${PNPM_VERSION} playwright@${PLAYWRIGHT_VERSION} \
  && playwright install --with-deps chromium-headless-shell \
  && apt-get clean \
  && rm -rf /var/cache/apt/archives /var/lib/apt/lists/* /root/.npm /root/.cache \
  && chmod -R a+rX /opt/pw-browsers

# The Astro toolchain, installed once here so a site build never reaches the
# registry. A site links /opt/astro/node_modules; astro/README.md says how,
# and which versions a site's package.json has to carry.
COPY astro /opt/astro
RUN cd /opt/astro \
  && pnpm install --frozen-lockfile \
  && rm -rf /root/.local/share/pnpm /root/.cache \
  && chmod -R a+rX /opt/astro

# Non-root. /workspace, /tmp and the home directory are the writable places;
# everything else is root-owned, so the Developer's user cannot change the
# toolchain, the control server or the image it runs in. One exception: the
# system CA bundle. HTTPS egress goes through the platform's outbound proxy,
# which terminates TLS with an ephemeral CA, and the control server appends
# that CA to the bundle at start and exits if it cannot (measured
# 2026-09-15). Trust for outbound TLS is the only thing the file decides;
# what a command may reach is decided at the proxy, outside the container.
RUN groupadd --gid 1000 reme \
  && useradd --uid 1000 --gid reme --create-home --shell /bin/bash reme \
  && chown reme:reme /workspace /etc/ssl/certs/ca-certificates.crt \
  && chmod -R go-w /opt /container-server /usr/local/lib/node_modules
USER reme
WORKDIR /workspace
