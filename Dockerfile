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
# Provide secrets at run time via --env-file .env
# Mount a local config override: -v /your/config.yaml:/config.yaml:ro
#   and set -e ZANUDA_CONFIG=/config.yaml
# Mount a data volume for persistent state: -v zanuda-data:/root/.zanuda
CMD ["node", "dist/index.js"]
