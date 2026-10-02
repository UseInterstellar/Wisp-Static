FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PORT=5001
ENV HOST=0.0.0.0
ENV LOG_LEVEL=INFO

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node

CMD ["node", "src/index.js"]
