# The builder sandbox (ADR-031): a filesystem and a shell for the Developer,
# and nothing else. No key, token or connection string is baked in or handed
# in; the Worker holds those. Egress, the CA trust and every command's
# variables are decided by RemeSandbox in apps/orchestrator/src/container.ts,
# not here.
#
# Node 22 on Debian trixie: the 0.12 image ran Node 22, and the starter-site,
# which builds here, pins `@types/node` to it. The digests pin what the tags
# resolved to on 2026-10-19.
FROM docker.io/library/node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa

# Toolchain versions, checked against npm on 2026-09-15.
ARG PNPM_VERSION=10.33.4
ARG PLAYWRIGHT_VERSION=1.63.0
# For the install below; a command gets it from RemeSandbox, not from here.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

# What the commands use that the slim base lacks: the 0.12 base had them.
# The fonts are that base's, for the screenshots and axe. Then pnpm, and
# Playwright with the headless Chromium shell plus its system libraries:
# screenshots need no windowed browser. The browsers live under /opt so every
# user can read them and no user can write them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git procps zstd \
    fontconfig fonts-dejavu-core fonts-freefont-ttf fonts-ipafont-gothic \
    fonts-liberation fonts-noto-color-emoji fonts-tlwg-loma-otf \
    fonts-unifont fonts-wqy-zenhei xfonts-cyrillic xfonts-scalable \
  && npm install -g pnpm@${PNPM_VERSION} playwright@${PLAYWRIGHT_VERSION} \
  && playwright install --with-deps chromium-headless-shell \
  && apt-get clean \
  && rm -rf /var/cache/apt/archives /var/lib/apt/lists/* /root/.npm /root/.cache \
  && chmod -R a+rX /opt/pw-browsers

# The helper `Files` in @cloudflare/sandbox runs for each file call. Its tag
# must equal the @cloudflare/sandbox version in apps/orchestrator/package.json.
COPY --from=docker.io/cloudflare/sandbox:1.0.1@sha256:e796e813de8213fb062bba279ddeddbf61277389a2cc7b3e4620075a9188843b /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# The Astro toolchain, installed once here so a site build never reaches the
# registry. A site links /opt/astro/node_modules; astro/README.md says how,
# and which versions a site's package.json has to carry.
COPY astro /opt/astro
RUN cd /opt/astro \
  && pnpm install --frozen-lockfile \
  && rm -rf /root/.local/share/pnpm /root/.cache \
  && chmod -R a+rX /opt/astro

# Non-root: /workspace, /tmp and the home directory are the writable places
# and everything else is root's. Under the `durable_object` policy the user
# sets the owner of the files a command makes and no more: the platform gives
# every process root's capabilities (ADR-031 amendment, 2026-10-19). The node
# base's own user holds uid 1000, which reme keeps from the 0.12 image.
RUN userdel --remove node \
  && groupadd --gid 1000 reme \
  && useradd --uid 1000 --gid reme --create-home --shell /bin/bash reme \
  && mkdir /workspace \
  && chown reme:reme /workspace \
  && chmod -R go-w /opt /usr/local/lib/node_modules
USER reme
WORKDIR /workspace
# 1.0 runs commands beside the main process; this one only keeps the
# container up.
CMD ["sleep", "infinity"]
