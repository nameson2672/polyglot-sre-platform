FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --project tsconfig.json

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --from=build --chown=nonroot:nonroot /app/package.json ./package.json
USER nonroot
EXPOSE 8082
CMD ["dist/index.js"]
