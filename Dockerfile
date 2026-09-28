# Stage 1: install prod deps + build CSS.
#
# Pinned to BUILDPLATFORM (the builder's own arch), NOT the target arch. Nothing
# this stage produces is architecture-specific: every production dependency is
# pure JS, and the only native binaries in the tree (tailwind oxide, lightningcss,
# rollup, esbuild) are devDependencies that `npm prune --omit=dev` strips below.
#
# Without this, a multi-arch build runs `npm ci` for the non-native arch under
# QEMU emulation, which intermittently dies with "uncaught target signal 4
# (Illegal instruction)" — the crash depends on what V8 JITs and which CPU the
# runner lands on, so it fails on some releases and not others. Building once,
# natively, removes the emulation entirely.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
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
