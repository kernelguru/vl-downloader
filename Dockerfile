FROM node:22-alpine AS builder

WORKDIR /vl-downloader
COPY . .
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci
RUN npm run build

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
    redis

COPY --from=builder /vl-downloader/package.json /vl-downloader/package-lock.json ./
COPY --from=builder /vl-downloader/src/backend/package.json ./src/backend/package.json
COPY --from=builder /vl-downloader/src/frontend/package.json ./src/frontend/package.json
RUN npm ci --omit=dev --workspace backend --include-workspace-root=false \
    && npm cache clean --force \
    && rm -rf src package.json package-lock.json

COPY --from=builder /vl-downloader/dist .
COPY --from=builder /vl-downloader/src/backend/.env.default ./.env

# downloads + database are volumes; make the app dir usable for any uid
RUN mkdir -p backend/downloads backend/config && chmod -R a+rwX /vl-downloader

EXPOSE 3000
VOLUME ["/vl-downloader/backend/downloads", "/vl-downloader/backend/config"]
CMD ["node", "backend/src/main.js"]
