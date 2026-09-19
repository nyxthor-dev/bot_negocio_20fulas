# Publisher Manager Bot v2.1 — Fase 2

Bot de WhatsApp para **reenvío de publicaciones a grupos y canales** donde el dispositivo es administrador, controlado mediante un panel web integrado.

Construido sobre [`@fer2809fl/baileys`](https://www.npmjs.com/package/@fer2809fl/baileys) + TypeScript + `better-sqlite3` + Fastify.

## ✨ Novedades de la v2.1 (Fase 2)

- ✅ **Panel web integrado** en `web/` arrancado desde `index.ts`
  - Frontend HTML/CSS/JS vanilla, dark theme, layout sidebar + main
  - Sin login por ahora (próxima fase)
  - Vista "Publicar" + vista "Historial"
  - API REST en `/api/*`
- ✅ **API de publicación**
  - `GET /api/groups` — lista grupos admin (cache SQL)
  - `POST /api/groups/refresh` — sincroniza con WhatsApp
  - `POST /api/publish` — envía texto con decoraciones
  - `GET /api/publish/history` — últimas 50 publicaciones

## ✨ Novedades de la v2.0 (Fase 1)

- ❌ **Eliminado el sistema de comandos** (`cmd-loader`, `messageHandler`, `cmd/`). El bot ya no responde a mensajes entrantes con prefijo `!` — es un publicador puro.
- ✅ **Base de datos SQLite** (`better-sqlite3`) con tablas:
  - `admin_credentials` — usuario/contraseña del panel web admin
  - `groups_cache` — caché de grupos donde el bot es admin
  - `publish_log` — historial de publicaciones enviadas
- ✅ **Credenciales admin auto-generadas** en la primera ejecución. Se muestran en consola una sola vez y se guardan hasheadas (scrypt) en SQL.
- ✅ **Módulo de decoración de texto** (`lib/textDecorations.ts`):
  - Tag "Reenviado" (`isForwarded`)
  - Tag "Reenviado muchas veces" (`forwardingScore`)
  - Menciones `@user` (`mentionedJid`)
  - Negrita `*texto*`, cursiva `_texto_`, tachado `~texto~`, monoespaciado
  - Link preview enriquecido (`externalAdReply`)
  - Conversión automática markdown estándar → sintaxis WhatsApp
- ✅ **Módulo nuevo de botones interactivos nativos** (`lib/interactiveButtons.ts`):
  - **URL button** — abre un enlace al hacer click
  - **COPY button** — copia un código al portapapeles
  - **CALL button** — inicia una llamada telefónica
  - **REPLY button** — botón de respuesta rápida
  - **ListMessage** — menú desplegable con secciones y filas (hasta 10)
  - Soporta máximo 3 botones por mensaje (límite de WhatsApp)
  - Decoraciones aplicables también a mensajes con botones

## 📁 Estructura

```
Publisher Manager-v2/
├── index.ts                    # Entry point
├── package.json
├── tsconfig.json
├── config.example.json         # Plantilla de configuración
├── lib/
│   ├── logger.ts               # Logger pino con colores
│   ├── consoleFilter.ts        # Filtro de ruido de libsignal/baileys
│   ├── utils.ts                # Helpers: jid, delay, isValidPhone, etc.
│   ├── config.ts               # Carga/valida config.json
│   ├── db.ts                   # SQLite (better-sqlite3) con schema
│   ├── adminAuth.ts            # Bootstrap de credenciales admin (scrypt)
│   ├── client.ts               # WASocket + QR + reconexión + broadcast
│   ├── textDecorations.ts      # Decoradores: forwarded, menciones, markdown
│   └── interactiveButtons.ts   # Botones nativos: URL / CALL / REPLY / List
├── web/                        # Panel web (Fastify + HTML/CSS/JS estático)
│   ├── server.ts               # Arranque del servidor Fastify
│   ├── routes/
│   │   ├── groups.ts           # API /api/groups
│   │   └── publish.ts          # API /api/publish + history
│   └── public/                 # Frontend estático
│       ├── index.html         # Estructura del panel (sidebar + main)
│       ├── styles.css          # Dark theme minimalista
│       └── app.js              # Lógica del panel (vanilla JS)
├── scripts/
│   ├── smoke-test.ts           # Test de bootstrap (DB + admin + builders)
│   └── web-smoke-test.ts       # Test del servidor web
└── data/
    ├── auth/                   # Credenciales de sesión WhatsApp (multi-file JSON)
    └── bot.db                  # SQLite (se crea solo en primera ejecución)
```

## 🚀 Instalación

```bash
cd Publisher Manager-v2
npm install
npm approve-scripts --all      # necesario en npm 11+ para better-sqlite3
npm rebuild better-sqlite3     # compila el binario nativo
```

## ⚙️ Configuración

```bash
cp config.example.json config.json
```

Editá `config.json` con tu número de teléfono (formato internacional sin `+` ni espacios):

```json
{
  "bot": {
    "phone": "5491112345678",
    "name": "Publisher Manager",
    "pairingMethod": null
  },
  "storage": {
    "authFolder": "./data/auth",
    "dbPath": "./data/bot.db"
  },
  "logging": {
    "level": "info"
  },
  "web": {
    "enabled": true,
    "port": 3000,
    "host": "0.0.0.0"
  }
}
```

- `bot.pairingMethod`: `"qr"` para escanear QR, `"code"` para código de 8 dígitos. Default: `"qr"` (sin preguntar por consola).
- `web.enabled`: `true` para arrancar el panel junto con el bot. `false` para deshabilitarlo.
- `web.port` y `web.host`: dónde escucha Fastify. `0.0.0.0` escucha en todas las interfaces; `127.0.0.1` sólo localhost.

## 🔁 Reverse proxy (nginx / Caddy / hidencloud / Cloudflare)

El panel web está configurado con `trustProxy: true` para funcionar detrás de un reverse proxy. Algunos puntos clave:

1. **El panel arranca ANTES que WhatsApp** — esto es crítico: aunque WhatsApp no esté conectado todavía, el panel ya responde HTTP en el puerto configurado. Así el reverse proxy nunca recibe "connection refused".

2. **Configuración típica en hidencloud** (o equivalente nginx):
   - `bot` escucha en `0.0.0.0:3000` (o el puerto que pongas en `web.port`)
   - Reverse proxy forwardea HTTPS → HTTP `localhost:3000`
   - Pasar las cabeceras `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`

3. **Ejemplo de nginx**:
   ```nginx
   server {
     listen 443 ssl;
     server_name panelresend.hidenfree.com;

     ssl_certificate /path/to/cert.pem;
     ssl_certificate_key /path/to/key.pem;

     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
     }
   }
   ```

4. **Troubleshooting**:
   - Si el navegador te redirige al dominio raíz del proxy (ej: `hidencloud.com`), revisá que el proxy really apunte al puerto local correcto del bot.
   - Si recibís "connection refused", esperá unos segundos a que el bot arranque (el panel tarda ~1s en estar listo después de iniciar el proceso).
   - Verificá que el puerto `web.port` esté abierto en el firewall del servidor.

## ▶️ Uso

```bash
npm start
# o, con hot reload:
npm run dev
```

### Primera ejecución

1. Se abre SQLite (`data/bot.db`) y se crean las tablas.
2. Se generan credenciales admin automáticamente (usuario + contraseña aleatoria de 20 chars en 4 grupos).
3. Se muestran en consola en un cuadro tipo:
   ```
   ╔════════════════════════════════════════════════════════════════╗
   ║   🔐  CREDENCIALES DEL PANEL WEB ADMIN — PRIMERA EJECUCIÓN      ║
   ║                                                                  ║
   ║   Usuario:    admin                                             ║
   ║   Contraseña: XXXXX-XXXXX-XXXXX-XXXXX                           ║
   ║                                                                  ║
   ║   ⚠️  Guardá estas credenciales en un lugar seguro.              ║
   ║   No se volverán a mostrar.                                      ║
   ╚════════════════════════════════════════════════════════════════╝
   ```
4. Se conecta a WhatsApp (QR o pairing code según configuración).
5. Al conectar, sincroniza la lista de grupos donde es admin y los cachea en SQL.
6. Si `web.enabled` es `true`, arranca el panel web en `http://localhost:3000`.

### Ejecuciones siguientes

- Carga las credenciales admin existentes de SQL (no las vuelve a mostrar).
- Reconecta usando la sesión persistente en `data/auth/`.
- Re-sincroniza grupos admins al cache.
- Arranca el panel web (si está habilitado).

## 🌐 Panel web

Accedé desde el navegador a `http://localhost:3000` (o el puerto configurado).

### Vista "Publicar"

1. Escribí el texto del mensaje en el textarea.
2. Marcá las decoraciones opcionales:
   - Tag "Reenviado"
   - Reenviado muchas veces (forwardingScore 25)
   - Convertir Markdown (ej: `**bold**` → `*bold*`)
3. Seleccioná los grupos destino de la lista (o "Seleccionar todos").
4. Si la lista está vacía, pulsá "Sincronizar" para forzar la actualización desde WhatsApp.
5. Pulsá "Publicar".
6. El panel muestra resultados individuales por grupo (enviado / fallido).

### Vista "Historial"

Muestra las últimas 50 publicaciones enviadas, con su estado y fecha.

### API REST

Todas las rutas están bajo `/api/*`:

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`  | `/api/groups` | Lista grupos admin (cache) |
| `POST` | `/api/groups/refresh` | Sincroniza grupos desde WhatsApp |
| `GET`  | `/api/groups/all` | Lista todos los grupos donde participa el bot |
| `POST` | `/api/publish` | Envía texto con decoraciones |
| `GET`  | `/api/publish/history` | Últimas 50 publicaciones |

#### Ejemplo: publicar texto

```bash
curl -X POST http://localhost:3000/api/publish \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hola *mundo*!",
    "target_jids": ["120363xxx@g.us"],
    "decorations": { "forwarded": true, "parseMarkdown": true }
  }'
```

## 🧩 Módulos principales

### `lib/textDecorations.ts`

```typescript
import { buildMessage, forwardedDecoration, mentionsDecoration } from './lib/textDecorations.ts'

const message = buildMessage({
  text: '*Hola* _mundo_ ~cruel~ ||secreto|| `codigo`',
  decorations: {
    forwarded: true,
    forwardingScore: 25,
    mentions: [{ phone: '5491112345678', name: 'Juan' }],
    parseMarkdown: true
  }
})

await sock.sendMessage(groupId, message)
```

### `lib/interactiveButtons.ts`

```typescript
import {
  buildTemplateButtonsMessage,
  urlButton,
  copyButton,
  callButton,
  replyButton
} from './lib/interactiveButtons.ts'

// Mensaje con botones nativos URL / COPY / CALL
const msg = buildTemplateButtonsMessage({
  text: 'Elegí una opción:',
  title: 'Menú principal',
  footer: 'Publisher Manager Bot',
  buttons: [
    urlButton('Visitar web', 'https://ejemplo.com'),
    copyButton('Copiar código', 'PROMO-2024'),
    callButton('Llamar', '+5491112345678')
  ]
})

await sock.sendMessage(groupId, msg)
```

```typescript
import { buildListMessage } from './lib/interactiveButtons.ts'

// Menú tipo lista con secciones
const list = buildListMessage({
  text: 'Seleccioná una categoría:',
  buttonText: 'Ver opciones',
  title: 'Catálogo',
  sections: [
    {
      title: 'Frutas',
      rows: [
        { id: 'f1', title: 'Manzana', description: 'Roja y dulce' },
        { id: 'f2', title: 'Banana', description: 'Amarilla' }
      ]
    },
    {
      title: 'Verduras',
      rows: [
        { id: 'v1', title: 'Lechuga', description: 'Verde y fresca' }
      ]
    }
  ]
})

await sock.sendMessage(groupId, list)
```

### `lib/client.ts` — publicación a grupos

```typescript
import { getAdminGroups, broadcastToTargets, getSocket } from './lib/client.ts'

// Obtener grupos donde soy admin
const adminGroups = await getAdminGroups(true)
const jids = adminGroups.map(g => g.id)

// Broadcast a todos los grupos admin
const results = await broadcastToTargets(jids, message, 1500)
// results: [{ jid, success, messageId?, error? }, ...]
```

## 🗄️ Esquema SQL

```sql
CREATE TABLE admin_credentials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,    -- scrypt:salt:hash
  created_at      INTEGER NOT NULL,
  first_run       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE groups_cache (
  jid             TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  is_admin        INTEGER NOT NULL DEFAULT 0,
  is_owner        INTEGER NOT NULL DEFAULT 0,
  last_seen       INTEGER NOT NULL
);

CREATE TABLE publish_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  target_jid      TEXT NOT NULL,
  content_type    TEXT NOT NULL,    -- text|image|video|audio|document|sticker
  text            TEXT,
  media_path      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  sent_at         INTEGER NOT NULL,
  error           TEXT
);
```

## 🛣️ Roadmap

- ✅ **Fase 1** (esta versión): limpieza + SQL + admin auth + decoraciones + botones nativos
- 🚧 **Fase 2** (próxima): panel web Fastify + login JWT + página Publicar + upload multimedia
- 🔮 **Fase 3** (futuro): programación cron, plantillas guardadas, estadísticas, multi-admin

## 📝 Notas

- Las credenciales de sesión se guardan en `data/auth/` (multi-file JSON, no en SQLite).
- Si WhatsApp cierra sesión (logout), borrar `data/auth/` y volver a vincular.
- Las credenciales admin se guardan con scrypt + salt de 16 bytes, no con bcrypt (evita dependencias nativas extras).
- Para recuperar credenciales admin perdidas: borrar la fila en `admin_credentials` y reiniciar el bot.
