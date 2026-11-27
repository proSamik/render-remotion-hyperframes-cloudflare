# Pure Remotion render image. Build context: the repository root.
#   npm run docker:build          (bundles the site first, then: docker build -f Dockerfile ../..)
# `wrangler deploy` builds the same file (see wrangler.jsonc).
FROM node:22-bookworm-slim

# 1. What Chrome Headless Shell needs: the list from https://www.remotion.dev/docs/docker.
#    Remotion brings its own FFmpeg, so no ffmpeg package.
# 2. libegl1 libgles2 libgl1-mesa-dri: Mesa's software OpenGL (llvmpipe). Only needed for WebGL content rendered
#    with gl "angle-egl" (docs/gl-backends.md). Delete the line if you have no three.js or shader content.
# 3. Fonts. An image without fonts renders text invisibly and reports no error. These are a small open baseline;
#    add fonts-noto-cjk for Chinese, Japanese and Korean (docs/fonts.md).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
      libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
      libegl1 libgles2 libgl1-mesa-dri \
      fontconfig fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# The project's runtime dependencies: @remotion/renderer at the pinned version. No bundler in the image.
WORKDIR /app/project
COPY examples/remotion-only/package.json examples/remotion-only/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Chrome Headless Shell, the build this Remotion version was tested with.
RUN node -e "require('@remotion/renderer').ensureBrowser().then(() => console.log('browser ready'))"

# Optional: a second browser for WebGL content. Remotion's own Chromium build cannot use Mesa (gl "angle-egl");
# Google's chrome-headless-shell can. For a heavy 3D scene that was 2.4 times cheaper than SwiftShader in our
# measurement, and 1.3 times cheaper for the small Cube of this example.
# Build with:  docker build --build-arg WEBGL_CHROME_VERSION=158.0.8127.88 ...
# Without the argument nothing is installed and WebGL content renders on SwiftShader ("swangle"). docs/gl-backends.md
ARG WEBGL_CHROME_VERSION=""
RUN if [ -n "$WEBGL_CHROME_VERSION" ]; then \
      apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* \
      && npx -y @puppeteer/browsers@3.2.1 install chrome-headless-shell@$WEBGL_CHROME_VERSION --path /opt/webgl-chrome \
      && ln -s "$(find /opt/webgl-chrome -name chrome-headless-shell -type f | head -1)" /usr/local/bin/chrome-headless-shell-webgl \
      && find /opt/webgl-chrome -name '*.zip' -delete && npm cache clean --force; \
    fi
ENV REMOTION_WEBGL_BROWSER_EXECUTABLE=/usr/local/bin/chrome-headless-shell-webgl

# The site made by `remotion-cloudflare sites create` (deploySite()), and the task server with the Remotion engine.
COPY examples/remotion-only/build/sites /app/sites
COPY packages/core/src /app/packages/core/src
COPY packages/cloudflare-containers/container /app/packages/cloudflare-containers/container

ENV NODE_ENV=production \
    PORT=8080 \
    RENDER_ENGINE=/app/packages/cloudflare-containers/container/engine.ts \
    REMOTION_PROJECT_DIR=/app/project \
    REMOTION_SITES_DIR=/app/sites
EXPOSE 8080
# dumb-init forwards SIGTERM and reaps the browser's child processes.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/app/packages/core/src/container-server.ts"]
