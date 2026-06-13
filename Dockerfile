# ── build ────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY config ./config
# Run as a non-root user. The container holds a GitHub PAT and LLM API keys;
# there is no reason for those to be in a root-owned process.
RUN groupadd --gid 1001 zanuda \
 && useradd --uid 1001 --gid zanuda --no-create-home zanuda \
 && mkdir -p /home/zanuda/.zanuda \
 && chown -R zanuda:zanuda /home/zanuda
USER zanuda
ENV HOME=/home/zanuda
# Provide secrets at run time via --env-file .env
# Mount a local config override: -v /your/config.yaml:/config.yaml:ro
#   and set -e ZANUDA_CONFIG=/config.yaml
# Mount a data volume for persistent state: -v zanuda-data:/home/zanuda/.zanuda
CMD ["node", "dist/index.js"]
