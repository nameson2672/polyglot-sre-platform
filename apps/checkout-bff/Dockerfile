# syntax=docker/dockerfile:1.7

# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- prune dev deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---- distroless runtime ----
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production

EXPOSE 8081

USER nonroot

ENTRYPOINT ["node", "dist/index.js"]
