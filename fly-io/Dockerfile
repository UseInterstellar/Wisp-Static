FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-slim AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production

EXPOSE 5001

CMD ["node", "src/index.js"]
