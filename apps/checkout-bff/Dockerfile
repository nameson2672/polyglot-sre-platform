# syntax=docker/dockerfile:1.7

# ---- build stage ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- prune dev deps ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---- distroless runtime ----
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Chaos injection is off by default. The `bad-v2` demo image is built with
# `--build-arg CHAOS_ERROR_RATE=0.05` so the image itself returns ~5% 500s.
ARG CHAOS_ERROR_RATE=0

ENV NODE_ENV=production \
    APP_ENV=production \
    CHAOS_ERROR_RATE=${CHAOS_ERROR_RATE}

EXPOSE 8081

USER nonroot


ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/index.js"]
