# The deployable render service's image: Remotion, HyperFrames and the mix in one image, engine chosen per render.
# Build context: the repository root. Self-contained: the Remotion bundles and the mixed example's HyperFrames layer
# are made inside the build, so the machine that builds (your Docker, or Cloudflare's Workers Builds behind the Deploy
# button) needs nothing but Docker. `wrangler deploy` in the repository root builds this file (../wrangler.jsonc).

# ---- base: Chrome's libraries (the union of what Remotion and HyperFrames list), FFmpeg for HyperFrames (Remotion
#      brings its own), Mesa for WebGL, and an open font baseline (docs/fonts.md).
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init ffmpeg \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 libgbm-dev libasound2 \
      libglib2.0-0 libx11-6 libxcb1 libxext6 libxkbcommon-dev libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 \
      libegl1 libgles2 libgl1-mesa-dri \
      fontconfig fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
ENV HYPERFRAMES_TELEMETRY=0 DO_NOT_TRACK=1 PUPPETEER_SKIP_DOWNLOAD=true

# ---- sites: bundle the Remotion compositions and pre-render the mixed example's layer. Dev dependencies stay here.
FROM base AS sites
WORKDIR /src
COPY packages/core /src/packages/core
COPY packages/cloudflare-containers /src/packages/cloudflare-containers
COPY packages/hyperframes-engine /src/packages/hyperframes-engine
COPY examples/remotion-only/package.json examples/remotion-only/package-lock.json /src/examples/remotion-only/
RUN cd examples/remotion-only && npm ci --no-audit --no-fund
COPY examples/mixed/package.json examples/mixed/package-lock.json /src/examples/mixed/
RUN cd examples/mixed && npm ci --no-audit --no-fund \
    && node node_modules/hyperframes/bin/hyperframes.mjs browser ensure \
    && ln -s "$(find /root/.cache/hyperframes -name chrome-headless-shell -type f | head -1)" /usr/local/bin/hyperframes-chrome
ENV HYPERFRAMES_BROWSER_PATH=/usr/local/bin/hyperframes-chrome PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/hyperframes-chrome
COPY examples/remotion-only /src/examples/remotion-only
COPY examples/mixed /src/examples/mixed
RUN cd examples/remotion-only && npm run assets \
    && node ../../packages/cloudflare-containers/bin/remotion-cloudflare.mjs sites create src/index.ts --site-name=remotion --sites-dir=/sites
RUN cd examples/mixed && npm run assets && npm run layer \
    && node ../../packages/cloudflare-containers/bin/remotion-cloudflare.mjs sites create src/index.ts --site-name=mixed --sites-dir=/sites
COPY examples/hyperframes-only /src/examples/hyperframes-only
# The test tones, and the scripts the projects vendor (vendor.lock.json: fetched and checked by SHA-256).
RUN cd examples/hyperframes-only && npm run assets

# ---- runtime
FROM base
WORKDIR /app/deploy
COPY deploy/package.json deploy/package-lock.json ./
# Two browsers: each framework pins the Chrome Headless Shell build it is tested with.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    && node -e "require('@remotion/renderer').ensureBrowser().then(() => console.log('remotion browser ready'))" \
    && node node_modules/hyperframes/bin/hyperframes.mjs browser ensure \
    && ln -s "$(find /root/.cache/hyperframes -name chrome-headless-shell -type f | head -1)" /usr/local/bin/hyperframes-chrome
# 1. HyperFrames refuses its own download cache on Cloudflare ("Chrome not found"): tell it where the browser is.
# 2. HyperFrames' browser is a Google chrome-headless-shell, which renders WebGL on Mesa: Remotion uses it for WebGL.
ENV HYPERFRAMES_BROWSER_PATH=/usr/local/bin/hyperframes-chrome \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/hyperframes-chrome \
    REMOTION_WEBGL_BROWSER_EXECUTABLE=/usr/local/bin/hyperframes-chrome

COPY packages/core/src /app/packages/core/src
COPY packages/cloudflare-containers/container /app/packages/cloudflare-containers/container
COPY packages/hyperframes-engine /app/packages/hyperframes-engine
COPY examples/mixed/engine.ts examples/mixed/layer.ts /app/examples/mixed/
# From the sites stage: with the scripts it vendored (assets/vendor), so the layer's cache key matches the pre-rendered one.
COPY --from=sites /src/examples/mixed/hyperframes-layer /app/examples/mixed/hyperframes-layer
COPY deploy/engine.ts /app/deploy/engine.ts
COPY --from=sites /sites /app/sites
COPY --from=sites /src/examples/hyperframes-only/composition /app/projects/composition
COPY --from=sites /src/examples/hyperframes-only/long /app/projects/long

ENV NODE_ENV=production \
    PORT=8080 \
    RENDER_ENGINE=/app/deploy/engine.ts \
    REMOTION_PROJECT_DIR=/app/deploy \
    REMOTION_SITES_DIR=/app/sites \
    HYPERFRAMES_PROJECTS_DIR=/app/projects \
    HYPERFRAMES_CLI_DIR=/app/deploy \
    MIXED_LAYER_DIR=/app/examples/mixed/hyperframes-layer
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/app/packages/core/src/container-server.ts"]
