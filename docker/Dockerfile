FROM node:22-slim

WORKDIR /app

COPY docker/package.json docker/package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY docker/src ./src

ENV NODE_ENV=production
ENV HOST=0.0.0.0

CMD ["node", "src/index.js"]