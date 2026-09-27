# syntax=docker/dockerfile:1

# ---- Etapa 1: dependencias de producción ----
FROM node:22-slim AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# package.json obligatorio; lock y .npmrc opcionales (el * y [.] evitan fallo)
COPY package.json ./
COPY package-lock.json* .npmrc[.] ./

# Si hay lock → npm ci (reproducible). Si no → npm install (lo genera).
RUN if [ -f package-lock.json ]; then \
      echo "==> lock encontrado, usando npm ci"; \
      npm ci --omit=dev; \
    else \
      echo "==> lock NO encontrado, generando con npm install"; \
      npm install --omit=dev; \
    fi

# ---- Etapa 2: imagen final ----
FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production \
    WEB_ENABLED=true \
    TZ=America/Havana

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /app/data && chown -R node:node /app/data /app

USER node

EXPOSE 3000

CMD ["./node_modules/.bin/tsx", "index.ts"]
