# One image for every Node service: API, thumbnail worker, push worker,
# scheduler and the MCP server. The compose file picks the command.

# Pinned, Alpine release included: ffmpeg comes from that release's own
# repositories, and Alpine 3.24 is the first to carry the version the
# thumbnail pipeline is tested against. Dependabot proposes updates.
FROM node:26.12.0-alpine3.24 AS base
WORKDIR /app
RUN apk upgrade --no-cache
# ffmpeg decodes thumbnails. Not from Alpine's edge repository: edge's ffmpeg
# is rebuilt against libraries from edge/main that a stable base does not
# have, so installing it on top of a release can fail without warning.
RUN apk add --no-cache 'ffmpeg>=8.1.2' && \
    ffmpeg -version | head -n1

FROM base AS build
COPY package.json package-lock.json ./
RUN npm pkg delete scripts.prepare && npm ci --legacy-peer-deps
COPY tsconfig.json ./
COPY server/ ./server/
COPY clipnest-mcp/ ./clipnest-mcp/
RUN npx tsc -p tsconfig.json && npx tsc -p clipnest-mcp/tsconfig.json
# tsc only emits .js; the SQL migrations must travel with the build so the
# server can apply them on start.
RUN cp -R server/db/migrations dist/db/migrations && \
    mkdir -p dist-mcp/server/db && cp -R server/db/migrations dist-mcp/server/db/migrations
RUN npm prune --omit=dev --legacy-peer-deps

FROM base
ARG VERSION=dev
ENV APP_VERSION=${VERSION} NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-mcp ./dist-mcp
COPY package.json ./
USER node
EXPOSE 3000 3100
CMD ["node", "dist/index.js"]
