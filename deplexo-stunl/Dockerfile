FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-slim AS runtime

ARG STUNL_VERSION=v5.35.1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) stunl_arch=amd64 ;; \
         arm64) stunl_arch=arm64 ;; \
         *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/stunl \
       "https://github.com/stunl/cli/releases/download/${STUNL_VERSION}/stunl-linux-${stunl_arch}" \
    && chmod +x /usr/local/bin/stunl \
    && stunl -version \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY start.sh ./
RUN chmod +x start.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV LOG_LEVEL=INFO

EXPOSE 3000

CMD ["./start.sh"]
