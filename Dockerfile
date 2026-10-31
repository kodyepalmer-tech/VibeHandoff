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

ENV NODE_ENV=production
ENV APP_ROLE=portal
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=8 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/index.js"]
