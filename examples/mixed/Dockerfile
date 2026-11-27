# Mixed render image: Remotion as the host, HyperFrames for one layer. Build context: the repository root.
#   npm run docker:build
FROM node:22-bookworm-slim

# Both renderers in one image: Chrome's libraries (the union of what Remotion and HyperFrames list), FFmpeg for
# HyperFrames (Remotion brings its own), Mesa for WebGL (the alpha channel of the layer is decoded with WebGL),
# and an open font baseline.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init ffmpeg \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 libgbm-dev libasound2 \
      libglib2.0-0 libx11-6 libxcb1 libxext6 libxkbcommon-dev libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 \
      libegl1 libgles2 libgl1-mesa-dri \
      fontconfig fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/examples/mixed
COPY examples/mixed/package.json examples/mixed/package-lock.json ./
ENV HYPERFRAMES_TELEMETRY=0 DO_NOT_TRACK=1
# Two browsers: each framework pins the Chrome Headless Shell build it is tested with.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    && node -e "require('@remotion/renderer').ensureBrowser().then(() => console.log('remotion browser ready'))" \
    && node node_modules/hyperframes/bin/hyperframes.mjs browser ensure \
    && ln -s "$(find /root/.cache/hyperframes -name chrome-headless-shell -type f | head -1)" /usr/local/bin/hyperframes-chrome
# 1. Tell HyperFrames where its browser is. Without this the layer render fails on Cloudflare with "Chrome not found":
#    HyperFrames refuses its own download cache there because "/ can be changed by another user account".
# 2. HyperFrames' browser is one of Google's chrome-headless-shell builds, which can render WebGL on Mesa
#    (gl "angle-egl"). Remotion uses it for WebGL chunks only (docs/gl-backends.md).
ENV HYPERFRAMES_BROWSER_PATH=/usr/local/bin/hyperframes-chrome \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/hyperframes-chrome \
    REMOTION_WEBGL_BROWSER_EXECUTABLE=/usr/local/bin/hyperframes-chrome

COPY packages/core/src /app/packages/core/src
COPY packages/cloudflare-containers/container /app/packages/cloudflare-containers/container
COPY packages/hyperframes-engine /app/packages/hyperframes-engine
COPY examples/mixed/engine.ts examples/mixed/layer.ts examples/mixed/prerender-layer.ts ./
COPY examples/mixed/hyperframes-layer ./hyperframes-layer
# The site already contains the default layer (public/hf/...), rendered by `npm run site` on the build machine.
COPY examples/mixed/build/sites /app/sites

ENV NODE_ENV=production \
    PORT=8080 \
    RENDER_ENGINE=/app/examples/mixed/engine.ts \
    REMOTION_PROJECT_DIR=/app/examples/mixed \
    REMOTION_SITES_DIR=/app/sites \
    MIXED_LAYER_DIR=/app/examples/mixed/hyperframes-layer \
    HYPERFRAMES_CLI_DIR=/app/examples/mixed
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/app/packages/core/src/container-server.ts"]
