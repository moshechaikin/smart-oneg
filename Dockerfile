# Stage 1: install prod deps + build CSS
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:css && npm prune --omit=dev

# Stage 2: runtime
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public
RUN mkdir /data && chown node:node /data /app
USER node
VOLUME /data
EXPOSE 1836
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:1836/api/health || exit 1
CMD ["node", "server/index.js"]
