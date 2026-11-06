# Image unique : interface Vue construite + serveur Node (Express, SQLite intégré à Node)

# Multi-architecture (amd64 pour le serveur Docker, arm64 pour une VM Freebox Delta/Ultra) :
# les étapes 1 et 2 ne produisent que du JavaScript, elles tournent sur la machine de build
# sans émulation ; seule l'image finale est construite pour chaque architecture.

# 1. Interface
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2. Dépendances du serveur (Express uniquement, pas de module natif)
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 3. Image finale
FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data TZ=Europe/Paris
RUN apk add --no-cache tzdata ca-certificates
# Test de débit : client officiel Speedtest by Ookla (binaire statique, licence pour usage personnel acceptée au lancement)
ARG TARGETARCH
ARG SPEEDTEST_VERSION=1.2.0
RUN case "$TARGETARCH" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) echo "Architecture $TARGETARCH non prise en charge" >&2; exit 1 ;; esac \
 && wget -qO- "https://install.speedtest.net/app/cli/ookla-speedtest-${SPEEDTEST_VERSION}-linux-${arch}.tgz" | tar -xz -C /usr/local/bin speedtest \
 && chmod 755 /usr/local/bin/speedtest
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /web/dist ./public
# Base SQLite et sauvegardes dans /data (volume)
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
