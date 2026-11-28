# Pure HyperFrames render image. Build context: the repository root.
#   npm run docker:build
FROM node:22-bookworm-slim

# Chrome Headless Shell's libraries, FFmpeg (HyperFrames does not bring its own: it needs ffmpeg and ffprobe on PATH)
# and a small open font baseline. Debian's ffmpeg is the simple choice and a large one; HyperFrames' own images pin a
# static FFmpeg build instead (see docs/troubleshooting.md, "image size").
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init ffmpeg \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 libgbm1 libasound2 \
      libglib2.0-0 libx11-6 libxcb1 libxext6 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 \
      fontconfig fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# The pinned HyperFrames CLI, HyperFrames' distributed renderer (@hyperframes/producer, same version: split rendering)
# and the browser build they want. Puppeteer's own Chrome download is skipped: HyperFrames brings chrome-headless-shell.
WORKDIR /app/hyperframes
COPY examples/hyperframes-only/package.json examples/hyperframes-only/package-lock.json ./
ENV HYPERFRAMES_TELEMETRY=0 DO_NOT_TRACK=1 PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    && node node_modules/hyperframes/bin/hyperframes.mjs browser ensure \
    && ln -s "$(find /root/.cache/hyperframes -name chrome-headless-shell -type f | head -1)" /usr/local/bin/hyperframes-chrome
# Tell HyperFrames where its browser is. Without this the render fails on Cloudflare with "Chrome not found":
# HyperFrames refuses its own download cache there because "/ can be changed by another user account"
# (its own message; we did not look further). It works in plain Docker either way.
ENV HYPERFRAMES_BROWSER_PATH=/usr/local/bin/hyperframes-chrome \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/hyperframes-chrome

# The composition(s) this service renders, and the task server with the HyperFrames engine.
COPY examples/hyperframes-only/composition /app/projects/composition
COPY examples/hyperframes-only/long /app/projects/long
COPY packages/core/src /app/packages/core/src
COPY packages/hyperframes-engine /app/packages/hyperframes-engine

ENV NODE_ENV=production \
    PORT=8080 \
    RENDER_ENGINE=/app/packages/hyperframes-engine/engine.ts \
    HYPERFRAMES_PROJECTS_DIR=/app/projects \
    HYPERFRAMES_CLI_DIR=/app/hyperframes
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/app/packages/core/src/container-server.ts"]
