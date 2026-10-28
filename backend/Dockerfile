# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
RUN pnpm install --frozen-lockfile
COPY backend backend
RUN pnpm --filter whisper-hub-backend build
RUN pnpm --filter whisper-hub-backend deploy --prod --legacy /prod/backend

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ADD --checksum=sha256:e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3 \
  https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp /usr/local/bin/yt-dlp
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/* \
  && chmod 0755 /usr/local/bin/yt-dlp \
  && mkdir -p /data /app/backend \
  && chown -R node:node /data /app
WORKDIR /app/backend
COPY --from=build --chown=node:node /prod/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/migrations ./migrations
COPY --from=build --chown=node:node /app/backend/package.json ./package.json
USER node
CMD ["node", "dist/api/main.js"]

