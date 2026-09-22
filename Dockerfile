# syntax=docker/dockerfile:1

# ---- Etapa 1: dependencias de producción ----
# python3/make/g++ por si better-sqlite3 no encuentra prebuild y debe compilar
FROM node:22-slim AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# ---- Etapa 2: imagen final ----
FROM node:22-slim
WORKDIR /app

# WEB_ENABLED arranca el panel sin config.json (el resto llega por entorno:
# PORT la asigna Render, ADMIN_USER/ADMIN_PASSWORD opcionales para el bootstrap)
ENV NODE_ENV=production \
    WEB_ENABLED=true \
    TZ=America/Havana

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# data/ = SQLite + sesiones de WhatsApp (montar disco/volumen aquí para persistir)
RUN mkdir -p /app/data && chown -R node:node /app/data /app

# Correr como usuario no-root (defense-in-depth: si hay RCE, el atacante
# obtiene el contexto node en vez de root dentro del contenedor).
USER node

EXPOSE 3000

CMD ["./node_modules/.bin/tsx", "index.ts"]
