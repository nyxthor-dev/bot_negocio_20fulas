<p align="center">
  <img src="web/public/img/logo-full.png" alt="Publisher Manager" width="300">
</p>

# Publisher Manager

Panel de publicaciones **multi-cuenta** para WhatsApp: conectá varios números y reenviá mensajes a grupos y canales desde un panel web **mobile-first**, con plantillas, programaciones, historial de entregas y confirmación real de envío.

> **v3.5.0** · TypeScript + Fastify + SQLite (better-sqlite3) + `@fer2809fl/baileys`

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

### Usuarios y seguridad
- **Múltiples administradores** con roles (`superadmin` / `admin`) gestionados desde el panel.
- Login con **sesiones en cookie firmada**, contraseñas con **scrypt**, **rate-limit + bloqueo por usuario e IP** y tiempos de respuesta igualados (anti-enumeración).
- **Protección CSRF**, subida de multimedia **validada en serio** (base64 estricto) y descarga forzada para SVG/HTML/texto (anti-XSS almacenado).
- Errores 500 sin detalles internos y red de seguridad del proceso (`unhandledRejection` / `uncaughtException`) para reinicios limpios.

### Panel web mobile-first
- Diseño oscuro pensado para el celular: **botón flotante de publicación**, **bottom-nav** y sidebar de **2 elementos** (Publicar / Historial) con sub-tabs.
- Interfaz de adjuntos simple y consistente en Publicar, Plantillas y Programadas.
- Totalmente responsive, verificada en navegador (escritorio y móvil).

### Infraestructura
- **SQLite embebido**: sin servicios externos; todo vive en `data/` (base, sesiones y multimedia).
- **Migración automática desde la v2**: la sesión única antigua se importa como "Cuenta principal" sin re-escanear el QR; la base migra sola y el admin se promueve a superadmin.
- `Dockerfile` multi-stage, `render.yaml` con health check y **170 pruebas** automatizadas.

---

## 🚀 Cómo usarlo

```bash
git clone https://github.com/nyxthor-dev/bot_negocio_20fulas.git
cd bot_negocio_20fulas
npm install
npm start
```

1. **Primer arranque**: la consola imprime las credenciales del superadmin (una sola vez). También podés definirlas antes con `ADMIN_USER` y `ADMIN_PASSWORD`.
2. **Entrá al panel** en `http://localhost:3000` e iniciá sesión.
3. **Vinculá tus números** en *Historial → Cuentas* escaneando el QR (o con código de vinculación).
4. **Publicá**: escribí el mensaje, adjuntá multimedia si querés, marcá los destinos por cuenta y tocá Publicar. Si un destino está en varias cuentas, elegí con cuál enviar.
5. Opcional: guardá **Plantillas** para reutilizar mensajes y creá **Programadas** para envíos automáticos. Todo queda registrado en el **Historial** con su confirmación de entrega.

> Sin `config.json` el sistema se configura 100 % por variables de entorno (ver tabla en [Despliegue](#️-despliegue)).

| Script | Qué hace |
|---|---|
| `npm start` / `npm run dev` | Arranca bot + panel |
| `npm run create-admin` | Crea un administrador por consola |
| `npm run typecheck` | Verificación de tipos |
| `npm test` | Suite de pruebas completa |

---

## 🖥️ Despliegue

### Variables de entorno

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `PORT` | Puerto del panel | `3000` |
| `HOST` | Interfaz de escucha | `0.0.0.0` |
| `WEB_ENABLED` | Activa el panel web | `true` en Docker/Render |
| `DATA_DIR` | Carpeta de datos (base, sesiones, multimedia) | `./data` |
| `LOG_LEVEL` | Nivel de logs (`fatal`…`trace`) | `info` |
| `TZ` | Zona horaria del servidor | hora del sistema |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Bootstrap del superadmin (sólo si aún no hay admins) | — |

> ⚠️ **Importante**: los datos viven en `data/` (SQLite + sesiones de WhatsApp + multimedia). Para no perder las sesiones entre despliegues, ese directorio debe ser **persistente** (disco en Render, volumen en Docker, carpeta del host en VPS).

### Render (1 clic)

El repo incluye `render.yaml` (Blueprint) y `Dockerfile`:

1. En Render: **New → Blueprint** apuntando a este repo (o **New → Web Service**; Render detecta el Dockerfile solo).
2. El health check ya está configurado en `/api/health`.
3. Variables sugeridas: `WEB_ENABLED=true` y `TZ` (ej. `America/Havana`); opcionalmente `ADMIN_USER`/`ADMIN_PASSWORD` como *sync: false* para el primer arranque.
4. **Disco persistente**: en planes de pago montá un disco en `/app/data` — en el plan *free* el sistema de archivos es efímero y las sesiones se pierden en cada redeploy.

### VPS con Docker

```bash
git clone https://github.com/nyxthor-dev/bot_negocio_20fulas.git
cd bot_negocio_20fulas
docker build -t publisher-manager .

mkdir -p /opt/publisher-manager/data
docker run -d --name publisher-manager \
  -p 3000:3000 \
  -v /opt/publisher-manager/data:/app/data \
  -e TZ=America/Havana \
  --restart unless-stopped \
  publisher-manager
```

Actualizar a una versión nueva:

```bash
git pull
docker build -t publisher-manager .
docker rm -f publisher-manager
# volver a ejecutar el mismo `docker run` de arriba (los datos quedan en el volumen)
```

### VPS con Node directo

Requisitos: **Node.js 18+** (recomendado 22) y herramientas de compilación (`python3 make g++`) por si `better-sqlite3` necesita compilar.

```bash
git clone https://github.com/nyxthor-dev/bot_negocio_20fulas.git
cd bot_negocio_20fulas
npm install
WEB_ENABLED=true PORT=3000 npm start
```

Con **pm2** para dejarlo como servicio:

```bash
npm i -g pm2
pm2 start npm --name publisher-manager -- start
pm2 save && pm2 startup
```

Las sesiones persisten tras reinicios del VPS (viven en `data/`). Para exponerlo al público poné un reverse proxy (nginx/Caddy) delante con HTTPS.

---

## 📜 Changelog

El historial detallado de versiones —desde la unión de la versión base con la de Carlos (v3.2.0) hasta la versión final (v3.5.0)— está en **[CHANGELOG.md](CHANGELOG.md)**.
