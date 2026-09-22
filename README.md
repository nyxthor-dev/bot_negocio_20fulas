<p align="center">
  <img src="web/public/img/logo-full.png" alt="Publisher Manager" width="300">
</p>

# Publisher Manager

Panel de publicaciones **multi-cuenta** para WhatsApp: conectá varios números y reenviá mensajes a grupos y canales desde un panel web **mobile-first**, con plantillas, programaciones, historial de entregas y confirmación real de envío.

> **v3.5.1** · TypeScript + Fastify + SQLite (better-sqlite3) + `@fer2809fl/baileys`
>
> Versión auditada y endurecida (commit `51ecd13`): CSP, rate limit, SameSite=Strict, sesión 8h, Docker non-root, bodyLimit por ruta, WAL checkpoint. Suite de 170 pruebas en verde.

---

## ✨ Características

### Multi-cuenta WhatsApp
- **Vinculá varios números** desde el panel, por **QR** o **código de vinculación**, sin salir del navegador.
- Cada cuenta maneja sus propios destinos: **grupos y canales**.
- **Estado de conexión en vivo**, reconexión automática y vincular/desvincular desde *Historial → Cuentas*.
- **Deduplicación entre cuentas**: si el mismo grupo/canal está seleccionado en varias cuentas, sólo una lo envía y el resto queda marcado como omitido.
- **Elección de cuenta**: en destinos compartidos aparece un selector **"⇄ Enviar con"** para que ELIJA qué cuenta envía; si la elegida se desconecta en una programación, el destino se **reasigna automáticamente** a otra cuenta participante conectada.

### Publicación
- Editor con formato de WhatsApp (**negrita, cursiva, tachado, monoespaciado**) e **insignia SOLO ADMINS**.
- **Multimedia hasta 50 MB**: imágenes, video, audio, documentos y **stickers `.webp`** (se envían como sticker).
- Publicación **inmediata** a múltiples destinos a la vez, con resultado por destino y sección **"⇄ N omitidos"** cuando hay duplicados.
- Fallback determinista si una elección ya no aplica (cuenta quitada o destino deseleccionado): el envío nunca se pierde por error de configuración.

### Plantillas
- Guardá mensajes **reutilizables con multimedia** y destinos precargados.
- Publicalas cuando quieras con un toque (también por API), con las mismas validaciones y dedupe que la publicación manual.

### Programaciones
- Frecuencia **una vez, diaria, semanal, mensual o por intervalo**, con ventana horaria configurable.
- **Zona horaria por administrador** (motor con tick de 20 s).
- La **elección de cuenta queda guardada** con cada mensaje programado: funciona aunque no haya nadie presente al momento del envío.
- Timeout de 60 s por mensaje y protección anti-solapamiento: editar una programación mientras se envía no corrompe su estado.

### Historial
- Registro completo de cada lote publicado: **estado real de entrega (ACK) por destino**, errores explícitos y cuenta que envió.
- Consultable por cuenta y por fecha.

### 🔒 Seguridad (auditoría v3.5.1)

El panel fue auditado (OWASP Top 10 + ASVS) y endurecido con las siguientes defensas:

| Defensa | Implementación |
|---|---|
| **Autenticación** | Token opaco de 32 bytes (256 bits de entropía), guardado en DB como SHA-256 del token. Cookie `HttpOnly` + `SameSite=Strict` + `Secure` (en HTTPS). TTL de sesión: **8 h**. |
| **Hashing de password** | `scrypt` con salt aleatorio de 16 bytes y `timingSafeEqual` (anti-timing). |
| **Anti-enumeración** | `dummyVerify()` iguala el tiempo de respuesta entre "usuario inexistente" y "password incorrecta". |
| **Rate limit de login** | Doble: 8 intentos/IP/15min + 6 intentos/usuario/15min (inmune a spoofing de `X-Forwarded-For`). |
| **Rate limit autenticado** | 30 acciones/min/admin (publish, media, schedules) y 10 publicaciones/min/admin (frena floods que banean cuentas WhatsApp). |
| **CSRF** | JSON-only Content-Type para POST/PUT/DELETE + `SameSite=Strict`. |
| **Headers de seguridad** | `Content-Security-Policy` restrictivo, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security` (HTTPS). |
| **SQL** | 100 % queries parametrizadas (better-sqlite3 placeholders `?`). Cero concatenación de strings. |
| **Validación de input** | JID regex whitelist, decoraciones con whitelist, base64 estricto, filenames random en disco. |
| **Anti-XSS almacenado** | `escapeHtml()` en frontend + `Content-Disposition: attachment` para SVG/HTML/texto en `/api/media`. |
| **Ownership checks** | Cada ruta verifica que `account_id` / `template_id` / `schedule_id` / `media_id` pertenezca al admin logueado (anti-IDOR). |
| **Docker non-root** | Contenedor corre como usuario `node` (UID 1000), no como `root`. |
| **WAL checkpoint** | `wal_autocheckpoint=1000` previene crecimiento infinito de `bot.db-wal`. |
| **Proceso robusto** | `unhandledRejection` se loguea y continúa; `uncaughtException` cierra limpio para reinicio del contenedor. |
| **npm audit** | 0 vulnerabilidades conocidas en 207 dependencias de producción. |

### Panel web mobile-first
- Diseño oscuro pensado para el celular: **botón flotante de publicación**, **bottom-nav** y sidebar de **2 elementos** (Publicar / Historial) con sub-tabs.
- Interfaz de adjuntos simple y consistente en Publicar, Plantillas y Programadas.
- Totalmente responsive, verificada en navegador (escritorio y móvil).

### Infraestructura
- **SQLite embebido**: sin servicios externos; todo vive en `data/` (base, sesiones y multimedia).
- **Migración automática desde la v2**: la sesión única antigua se importa como "Cuenta principal" sin re-escanear el QR; la base migra sola y el admin se promueve a superadmin.
- `Dockerfile` multi-stage, `render.yaml` con health check y **170 pruebas** automatizadas.

---

## 📋 Requisitos

| Componente | Versión | Notas |
|---|---|---|
| **Node.js** | 18+ (recomendado 22) | Requerido por `tsx` y Baileys |
| **Python 3 + make + g++** | cualquiera | Solo si `better-sqlite3` no tiene prebuild para tu plataforma |
| **Disco persistente** | — | **Crítico**: las sesiones WhatsApp y la DB viven en `data/`. Sin persistencia, cada reinicio requiere re-escanear QR. |
| **HTTPS** (recomendado) | — | Necesario para `Secure` cookie y HSTS. Usar reverse proxy (nginx/Caddy) o Render. |

---

## 🚀 Guía de Despliegue

Tenés tres opciones. Elegí la que mejor se adapte a tu contexto.

### Opción A — VPS con Docker (recomendada para producción)

La opción más económica y robusta: disco persistente, control total, ~$5/mes en cualquier VPS (Hetzner, DigitalOcean, Contabo, OVH).

#### Paso 1 — Preparar el VPS

```bash
# En el VPS, instalar Docker (Ubuntu/Debian):
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Salir y volver a entrar para que el grupo aplique

# Crear carpeta persistente para los datos:
sudo mkdir -p /opt/publisher-manager/data
sudo chown -R $USER:$USER /opt/publisher-manager
```

#### Paso 2 — Clonar y construir

```bash
git clone https://github.com/nyxthor-dev/bot_negocio_20fulas.git
cd bot_negocio_20fulas
docker build -t publisher-manager .
```

#### Paso 3 — Primer arranque con credenciales de superadmin

> **Importante**: en `NODE_ENV=production`, el sistema **exige** que definas `ADMIN_USER` y `ADMIN_PASSWORD` antes del primer arranque. Si no lo hacés, aborta con error claro. Esto evita que la password inicial quede en logs del contenedor.

Elegí una password fuerte (mínimo 8 caracteres, recomendado 16+ con mayúsculas, minúsculas, números y símbolos):

```bash
docker run -d --name publisher-manager \
  -p 3000:3000 \
  -v /opt/publisher-manager/data:/app/data \
  -e NODE_ENV=production \
  -e WEB_ENABLED=true \
  -e TZ=America/Havana \
  -e ADMIN_USER=superadmin \
  -e ADMIN_PASSWORD='TuClaveMuyFuerte!2026' \
  --restart unless-stopped \
  publisher-manager
```

#### Paso 4 — Verificar

```bash
# Ver logs en vivo:
docker logs -f publisher-manager

# Verificar que el panel responde:
curl http://localhost:3000/api/health
# → {"ok":true,"service":"publisher-manager","uptime":...}

# Login (probar credenciales):
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"superadmin","password":"TuClaveMuyFuerte!2026"}'
# → {"ok":true,"admin":{"id":1,"username":"superadmin","role":"superadmin"}}
```

#### Paso 5 — Reverse proxy con HTTPS (nginx + Let's Encrypt)

El panel **debe** servirse por HTTPS para activar `Secure` cookie, HSTS y proteger credenciales en tránsito.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Crear `/etc/nginx/sites-available/publisher-manager`:

```nginx
server {
    listen 80;
    server_name panel.tudominio.com;

    # Health check para Let's Encrypt
    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_read_timeout 90s;
        client_max_body_size 80M;   # permite subidas de multimedia hasta 75MB
    }
}
```

Activar y obtener certificado:

```bash
sudo ln -s /etc/nginx/sites-available/publisher-manager /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d panel.tudominio.com
```

Listo. Accedé a `https://panel.tudominio.com` y logueate con tus credenciales.

#### Actualizar a una versión nueva

```bash
cd bot_negocio_20fulas
git pull
docker build -t publisher-manager .
docker rm -f publisher-manager
# volver a ejecutar el mismo `docker run` de arriba (los datos quedan en el volumen /opt/publisher-manager/data)
```

> **Backup recomendado**: antes de actualizar, copiar el volumen: `cp -r /opt/publisher-manager/data /opt/publisher-manager/data.bak.$(date +%F)`

---

### Opción B — Render (sin tocar servidores)

Render maneja infraestructura, HTTPS y dominio automáticamente. Ideal si no querés administrar VPS.

#### Paso 1 — Conectar el repo

1. Andá a https://render.com y logueate.
2. **New → Blueprint** → seleccioná el repo `nyxthor-dev/bot_negocio_20fulas`.
3. Render detecta `render.yaml` automáticamente y crea el servicio.

#### Paso 2 — Configurar variables de entorno

En el panel de Render → **Environment** → agregar:

| Variable | Valor | Sync |
|---|---|---|
| `WEB_ENABLED` | `true` | yes |
| `TZ` | `America/Havana` | yes |
| `NODE_ENV` | `production` | yes |
| `ADMIN_USER` | `superadmin` | **no** (sensible) |
| `ADMIN_PASSWORD` | TuClaveMuyFuerte!2026 | **no** (sensible) |

> Marcá como *sync: false* las credenciales para que no se compartan con todo el equipo.

#### Paso 3 — Disco persistente (REQUIERE plan pago)

⚠️ **Crítico**: en el plan *free* el filesystem es efímero. Cada cold start (cada 15 min sin tráfico, o tras cada redeploy) **borra** `data/` — perdiendo sesiones WhatsApp, base de datos y multimedia.

En **plan Starter ($7/mes)** o superior, descomentar el bloque `disk` en `render.yaml`:

```yaml
disk:
  name: supab-data
  mountPath: /app/data
  sizeGB: 1
```

Sin esto, vas a tener que re-escanear el QR de **cada cuenta WhatsApp** tras cada cold start.

#### Paso 4 — Deploy

Render hace el deploy automáticamente al pushear a `main`. Verificá:

- **Logs** → deberías ver `Panel web escuchando en 0.0.0.0:$PORT`
- **Health check** → `https://tu-app.onrender.com/api/health` → `{"ok":true}`
- Login con tus credenciales → debería devolver 200 + `admin` en el body.

#### Actualizar

Simplemente `git push origin main`. Render reconstruye y redeploye automáticamente.

---

### Opción C — VPS con Node directo (sin Docker)

Para usuarios que prefieren Node directo y `pm2` como gestor de procesos.

#### Paso 1 — Instalar Node 22 + herramientas de compilación

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs python3 make g++

# Verificar:
node --version   # v22.x
npm --version    # 10.x
```

#### Paso 2 — Clonar e instalar

```bash
git clone https://github.com/nyxthor-dev/bot_negocio_20fulas.git
cd bot_negocio_20fulas
npm install
```

#### Paso 3 — Primer arranque con `ADMIN_PASSWORD`

```bash
NODE_ENV=production WEB_ENABLED=true PORT=3000 \
ADMIN_USER=superadmin ADMIN_PASSWORD='TuClaveMuyFuerte!2026' \
npm start
```

Verificá el login y luego dejalo corriendo con `pm2`:

```bash
sudo npm i -g pm2
pm2 start "NODE_ENV=production WEB_ENABLED=true ADMIN_USER=superadmin ADMIN_PASSWORD='TuClaveMuyFuerte!2026'" \
  --name publisher-manager -- npm start
pm2 save && pm2 startup
# ejecutar el comando que pm2 te sugiere para que arranque en boot
```

#### Paso 4 — Reverse proxy con HTTPS

Seguir el mismo paso 5 de la Opción A (nginx + certbot).

---

## 🧭 Uso del panel

Una vez desplegado, el flujo es:

1. **Entrá al panel** en tu URL (ej: `https://panel.tudominio.com`).
2. **Iniciá sesión** con las credenciales de superadmin configuradas.
3. **Vinculá tus números WhatsApp** en *Historial → Cuentas*:
   - Escaneá el QR con la app de WhatsApp del teléfono, **o**
   - Pedí un **código de vinculación** de 8 dígitos y entrarlo en el teléfono del número a vincular.
4. **Sincronizá grupos/canales**: tocá **👥 Grupos** o **📢 Canales** en *Publicar* para descargar los destinos donde la cuenta es admin.
5. **Publicá**: escribí el mensaje, adjuntá multimedia si querés, marcá los destinos por cuenta y tocá Publicar. Si un destino está en varias cuentas, elegí con cuál enviar (selector "⇄ Enviar con").
6. Opcional: guardá **Plantillas** para reutilizar mensajes y creá **Programadas** para envíos automáticos. Todo queda registrado en el **Historial** con su confirmación de entrega.

> Si manejás varias cuentas y publicás al mismo grupo desde varias, el dedupe automático evita duplicados: sólo una lo envía y el resto queda marcado como **⇄ omitido**.

---

## ⚙️ Variables de entorno (referencia)

| Variable | Descripción | Default | Requerida en producción |
|---|---|---|---|
| `PORT` | Puerto del panel | `3000` | No |
| `HOST` | Interfaz de escucha | `0.0.0.0` | No |
| `WEB_ENABLED` | Activa el panel web | `false` | Sí (Render/Docker) |
| `NODE_ENV` | Entorno de ejecución | — | **Sí** (`production`) |
| `DATA_DIR` | Carpeta de datos (base + sesiones + media) | `./data` | No |
| `LOG_LEVEL` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` | `info` | No |
| `TZ` | Zona horaria del servidor | hora del sistema | Recomendada |
| `ADMIN_USER` | Username del superadmin inicial | `admin` (sólo dev) | **Sí** (en producción) |
| `ADMIN_PASSWORD` | Password del superadmin inicial (min 8, máx 128 chars) | auto-generada (sólo dev) | **Sí** (en producción) |

> ⚠️ `ADMIN_USER` y `ADMIN_PASSWORD` **solo aplican al primer arranque**, cuando todavía no hay admins en la DB. Después de eso, gestioná los admins desde el panel (*Usuarios*).

> ⚠️ En `NODE_ENV=production` sin `ADMIN_USER`/`ADMIN_PASSWORD`, el proceso aborta. Esto es intencional: evita que la password inicial se genere y quede en logs del contenedor.

---

## 🛠️ Scripts disponibles

| Script | Qué hace |
|---|---|
| `npm start` | Arranca bot + panel (producción) |
| `npm run dev` | Modo watch con recarga en cambios (desarrollo) |
| `npm run create-admin` | Crea un administrador por consola (interactivo) |
| `npm run typecheck` | Verificación de tipos TypeScript (sin emit) |
| `npm test` | Suite completa de 170 pruebas automatizadas |

---

## 📁 Estructura del proyecto

```
bot_negocio_20fulas/
├── index.ts                  # Punto de entrada (orquesta todo)
├── lib/                      # Lógica de dominio
│   ├── adminAuth.ts          #   Autenticación (scrypt, sesiones, rate limit login)
│   ├── rateLimit.ts          #   Rate limit para endpoints autenticados
│   ├── db.ts                 #   SQLite (better-sqlite3) + migraciones
│   ├── client.ts             #   Cliente WhatsApp (Baileys) multi-cuenta
│   ├── scheduler.ts          #   Motor de programaciones (tick 20s)
│   ├── publishService.ts     #   Construcción y envío de mensajes
│   ├── media.ts              #   Subida/lectura de multimedia
│   ├── messageValidation.ts #   Validación de JIDs y decoraciones
│   ├── textDecorations.ts    #   Negrita/cursiva/tachado/mono de WhatsApp
│   ├── groups.ts             #   Sincronización de grupos
│   ├── newsletters.ts        #   Sincronización de canales
│   ├── delivery.ts           #   ACK de entrega por mensaje
│   ├── dedupe.ts             #   Deduplicación cross-cuenta
│   ├── config.ts             #   Lectura de config.json + env vars
│   ├── logger.ts             #   Logger Pino con formato ANSI
│   └── consoleFilter.ts      #   Filtra ruido de libsignal/baileys
├── web/                      # Panel web + API REST
│   ├── server.ts             #   Fastify + hooks (auth, CORS, CSP, rate limit)
│   ├── auth.ts               #   Cookie HttpOnly + helpers de sesión
│   ├── routes/               #   9 módulos de API REST
│   │   ├── auth.ts           #     /api/auth/login | status | logout
│   │   ├── accounts.ts       #     /api/accounts (cuentas WhatsApp)
│   │   ├── groups.ts          #     /api/groups (grupos @g.us)
│   │   ├── newsletters.ts    #     /api/newsletters (canales @newsletter)
│   │   ├── templates.ts      #     /api/templates (plantillas)
│   │   ├── schedules.ts       #     /api/schedules (programaciones)
│   │   ├── publish.ts         #     /api/publish (envío inmediato + historial)
│   │   ├── media.ts           #     /api/media (subida/lectura multimedia)
│   │   └── admins.ts          #     /api/admins (gestión de usuarios)
│   └── public/               #   Frontend estático (HTML + CSS + JS)
│       ├── index.html
│       ├── app.js            #     ~2200 LOC, mobile-first
│       └── styles.css
├── scripts/                  # 17 archivos de tests + utilidades
├── Dockerfile                # Multi-stage, USER node, NODE_ENV=production
├── render.yaml               # Blueprint para Render
├── config.example.json       # Template de config para desarrollo local
└── package.json
```

---

## 🔧 Configuración para desarrollo local

Si vas a modificar el código, usá `config.json` en vez de env vars:

```bash
git clone https://github.com/nyxthor-dev/bot_negocio_20fulas.git
cd bot_negocio_20fulas
npm install
cp config.example.json config.json
# editá config.json si querés (el default está bien para dev)
npm run dev
```

En desarrollo (sin `NODE_ENV=production`), el primer arranque genera automáticamente la password del superadmin y la imprime en consola con una caja ANSI. Guardala: no se vuelve a mostrar.

---

## 🩺 Diagnóstico y troubleshooting

### El panel no responde

```bash
# Verificar que el proceso está corriendo:
docker ps | grep publisher-manager        # Docker
pm2 status                                # pm2

# Ver logs:
docker logs -f publisher-manager          # Docker
pm2 logs publisher-manager               # pm2
```

### No puedo loguearme

1. Verificá que estés usando HTTPS (la cookie `Secure` no se setea en HTTP).
2. Si olvidaste la password del superadmin, podés resetearla conectándote a la DB:
   ```bash
   docker exec -it publisher-manager node -e "
     const Database = require('better-sqlite3');
     const db = new Database('/app/data/bot.db');
     const { scryptSync, randomBytes } = require('crypto');
     const salt = randomBytes(16).toString('hex');
     const hash = scryptSync('NuevaPassword123', salt, 64).toString('hex');
     db.prepare('UPDATE admin_credentials SET password_hash = ? WHERE username = ?').run('scrypt:'+salt+':'+hash, 'superadmin');
     console.log('Password reseteada a: NuevaPassword123');
   "
   ```
3. Cambiá la password desde el panel en *Usuarios* apenas entres.

### WhatsApp se desconecta

```bash
# Estado de cada cuenta desde el panel:
# Historial → Cuentas → debería decir "✓ Conectada"
# Si dice "○ Desconectada", tocá "Reconectar"
```

Si la cuenta fue baneada por WhatsApp (envíos masivos muy rápidos), esperá 24h y vinculá de nuevo. El rate limit de 10 publish/min está calibrado para evitar esto.

### Pierdo las sesiones tras cada reinicio

Estás en Render free o sin volumen Docker. Mirá la guía de despliegue (Opción A o B) — necesitás disco persistente en `/app/data`.

---

## 📜 Changelog

El historial detallado de versiones está en **[CHANGELOG.md](CHANGELOG.md)**.

### v3.5.1 — 2026-09-22 · Audit + hardening

- **Content-Security-Policy** header en todas las respuestas.
- **Rate limit** para endpoints autenticados (30 acciones/min, 10 publish/min).
- **SameSite=Strict** en cookie de sesión (era `Lax`).
- **SESSION_TTL_MS 8h** (era 7d) — reduce ventana de explotación si roban cookie.
- **Docker non-root** (USER node en Dockerfile).
- **bodyLimit por ruta** (2MB global, 75MB solo en `/api/media`).
- **wal_autocheckpoint=1000** previene WAL infinito.
- Token removido del JSON de `/api/auth/login` (cookie HttpOnly basta).
- `MAX_ASSIGN_ENTRIES=200` (anti-DoS en publish y templates).
- Abortar bootstrap en `NODE_ENV=production` sin `ADMIN_PASSWORD`.
- Suite de 170 pruebas en verde tras las fixes.
- `npm audit`: 0 vulnerabilidades.

---

## 📄 Licencia

Uso interno — todos los derechos reservados al autor del repositorio.
