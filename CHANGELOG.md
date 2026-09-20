# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado [SemVer](https://semver.org/lang/es/).

## [3.5.0] — 2026-09-20 · Versión final

Versión de consolidación: **se unió la versión base (`bot_negocio_20fulas`) con la versión de Carlos (`Supab`)**, se pulió todo el proyecto y se endureció la seguridad. Verificada con 170 pruebas automatizadas y revisión en navegador (escritorio y móvil).

### Añadido
- **Elección de cuenta para destinos duplicados**: cuando el mismo grupo/canal está seleccionado en varias cuentas, cada destino muestra un selector **"⇄ Enviar con"** para decidir qué cuenta lo envía (antes siempre ganaba la primera). Disponible en publicación inmediata, en cada mensaje de una programación y en la publicación por plantilla/API. La elección queda persistida con la programación (columna `assign_map`, migración automática de esquema).
- **Reasignación automática**: en programaciones (donde no hay nadie presente al enviar), si la cuenta elegida está desconectada, el destino pasa a otra cuenta participante conectada; si no hay ninguna, el fallo queda explícito por destino en el historial.
- Aviso **"⚠ desconectada"** en el selector de cuenta.
- Límite de **200 destinos por cuenta** en cada publicación.
- **Timeout de 60 s por mensaje** en el scheduler: un envío colgado no congela el resto de las programaciones.
- **Transacciones** en creación/edición de programaciones y borrado de cuentas (sin registros a medias); las programaciones que quedan sin mensajes se dan de baja solas.
- **Red de seguridad del proceso**: `unhandledRejection` se registra y continúa; `uncaughtException` cierra limpio para que Render/Docker lo re-levanten.
- Fallback determinista: si la elección ya no aplica (cuenta quitada, destino deseleccionado), el envío cae al orden determinista sin errores.

### Corregido
- Editar una programación mientras se está enviando ya se protege con guard de concurrencia: una "una vez" editada a diaria ya no termina marcada como terminada.
- Destinos repetidos entre dos mensajes de la MISMA cuenta ahora se rechazan con error claro (antes se perdían en silencio).
- La multimedia inline de "publicar" se guarda recién después de validar todo el envío (sin archivos huérfanos ante un error).
- Fuga de blobs de preview en el panel (`revokeObjectURL`).
- Cambiar la cuenta de un mensaje programado suelta los destinos que la nueva cuenta no alcanza.
- Re-render dirigido del selector de duplicados (sin chips ni selectores obsoletos ni saltos de scroll).

### Seguridad
- **IDOR** en `GET /api/publish/history/:id`: un admin podía leer detalles de lotes de OTRO admin conociendo el ID → ahora 404.
- **IDOR** en `POST /api/templates/:id/publish`: reescrito con las mismas validaciones que `POST /api/publish` (cuentas propias, destinos, delay acotado, dedupe y elección de cuenta).
- Bloqueo de login **por usuario** (6 fallos / 15 min, inmune a spoofing de `X-Forwarded-For`), además del bloqueo por IP existente.
- Tiempo de respuesta igualado para usuarios inexistentes (anti-enumeración, scrypt dummy).
- Base64 de multimedia validado en serio (charset + padding); SVG/HTML/texto se descargan como adjunto en vez de renderizarse (**anti-XSS almacenado**).
- Errores 500 sin detalles internos; cookie de sesión corrupta ya no rompe la autenticación.

## [3.4.0] — Identidad visual "Publisher Manager"

### Añadido
- Identidad **"Publisher Manager"**: logo completo flotante en el login, ícono en la barra superior (móvil) y en el sidebar (escritorio), favicon y apple-touch-icon propios.
- Textos del panel revisados para entrega al cliente; título de la página y metadatos renombrados.

### Eliminado
- Mini-logotipo anterior y referencias a marcas viejas.

## [3.3.0] — Correcciones y deduplicación

### Añadido
- **Deduplicación entre cuentas**: si varias cuentas del panel están en el MISMO grupo/canal, sólo la primera lo envía (en publicación inmediata y en programaciones). El resto queda en la sección "⇄ N omitidos" y la lista de destinos avisa con el chip "⇄ ya en {cuenta}".

### Corregido
- El atributo `hidden` ahora siempre gana en CSS: el login ya no aparece mezclado con el panel y desapareció el spinner "Subiendo multimedia…" fijo en pantalla.
- Header móvil siempre visible en pantallas chicas (sincronizar y cerrar sesión accesibles; antes no había forma de salir en móvil).
- El botón flotante de Publicar ya no se muestra en la vista Historial.

### Cambiado
- Adjuntar multimedia unificado: la vista Publicar usa la misma interfaz simple que los mensajes programados (botón "Adjuntar" + nombre/tamaño + preview compacto).
- Toggle "Convertir Markdown" eliminado de Publicar, plantillas y programaciones (el formato de WhatsApp se aplica siempre; el backend conserva el parseo por compatibilidad con datos viejos).
- Pulido móvil integral: filas de plantillas/programaciones/cuentas apiladas, inputs de 16 px (anti-zoom iOS), errores largos con salto de línea y revisión anti-overflow horizontal en todas las vistas.

## [3.2.0] — Unión de la versión base con la de Carlos

Primera versión unificada del proyecto: **se unió la versión base (`bot_negocio_20fulas` v2) con la de Carlos (`Supab` v3.1.1)**, portando todas las funciones multi-cuenta y conservando el diseño mobile-first del panel.

### Añadido
- Multi-cuenta WhatsApp completa: login con roles, vinculación por QR/código desde el panel, plantillas reciclables con multimedia, programaciones (una vez/diaria/semanal/mensual/intervalo con ventana), múltiples administradores, confirmación real de entrega (ACK), insignia SOLO ADMINS e historial por cuenta.
- Multimedia de **50 MB** (antes 20 MB) con bodyLimit de 75 MB, y stickers `.webp` integrados al sistema de media.
- **Migración automática desde la v2**: la sesión única antigua (`data/auth/creds.json`) se importa como "Cuenta principal" sin re-escanear el QR; la base SQLite migra sola y el admin se promueve a superadmin.

### Cambiado
- El panel se reorganizó en un **sidebar de 2 elementos** (Publicar / Historial) con sub-tabs: `Publicar · Plantillas · Programadas` e `Historial · Cuentas · Usuarios`.

## [2.1] — Versión base

Versión base del proyecto: bot de reenvío con panel web mobile-first, multimedia y stickers (commit inicial de este repositorio).
