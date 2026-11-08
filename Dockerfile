# Toolchain for native modules (sqlite3 has no musl prebuild for Node 22 and compiles)
FROM node:22-alpine AS base
RUN apk add --no-cache python3 py3-setuptools make g++
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
WORKDIR /vl-downloader

# noVNC web client for the built-in browser
FROM alpine:3 AS novnc
RUN apk add --no-cache git \
    && git clone --depth 1 --branch v1.6.0 https://github.com/novnc/noVNC.git /opt/novnc \
    && rm -rf /opt/novnc/.git /opt/novnc/tests /opt/novnc/docs

FROM base AS builder
COPY . .
RUN npm ci
RUN npm run build

# Production dependencies of the backend only
FROM base AS deps
COPY package.json package-lock.json ./
COPY src/backend/package.json ./src/backend/package.json
COPY src/frontend/package.json ./src/frontend/package.json
RUN npm ci --omit=dev --workspace backend \
    && rm -rf node_modules/backend node_modules/frontend

FROM node:22-alpine

WORKDIR /vl-downloader
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production \
    # Chromium needs a writable home, also when running as a non-root user (e.g. 99:100 on Unraid)
    HOME=/tmp

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto \
    redis \
    7zip \
    firefox \
    tigervnc \
    xdotool \
    xwd \
    websockify

COPY --from=novnc /opt/novnc /opt/novnc
COPY --from=deps /vl-downloader/node_modules ./node_modules

COPY --from=builder /vl-downloader/dist .
COPY --from=builder /vl-downloader/src/backend/.env.default ./.env

# downloads + database are volumes; make the app dir usable for any uid
RUN mkdir -p backend/downloads backend/config backend/inbox && chmod -R a+rwX /vl-downloader

EXPOSE 3000
VOLUME ["/vl-downloader/backend/downloads", "/vl-downloader/backend/config", "/vl-downloader/backend/inbox"]
CMD ["node", "backend/src/main.js"]
