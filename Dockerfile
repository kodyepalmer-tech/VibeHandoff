FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY fixtures ./fixtures
COPY public ./public
COPY scripts ./scripts
COPY src ./src

RUN chown -R node:node /app

ENV NODE_ENV=production
ENV APP_ROLE=portal
EXPOSE 3000

USER node

# Portal listens on PORTAL_PORT. The artifact role listens on ARTIFACT_PORT.
HEALTHCHECK --interval=15s --timeout=5s --retries=8 \
  CMD sh -c 'if [ "$APP_ROLE" = "artifact" ]; then port="${ARTIFACT_PORT:-3001}"; else port="${PORTAL_PORT:-3000}"; fi; curl -fsS "http://127.0.0.1:${port}/healthz"'

CMD ["node", "src/index.js"]
