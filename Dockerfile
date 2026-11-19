# Snake Arena 3D – Docker-Image
# Stufe 1 baut das Spiel, Stufe 2 ist der schlanke Server, der es ausliefert
# und die Mehrspieler-Verbindungen vermittelt.

# ---------- Stufe 1: Spiel bauen ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm test && npx vite build

# ---------- Stufe 2: Server ----------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    BASE_PATH=/
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/server.mjs ./
COPY --from=build /app/dist ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
CMD ["node", "server.mjs"]
