/**
 * Rutas API para multimedia del panel.
 *
 *   POST /api/media          -> guarda un archivo { base64, mime_type, file_name }
 *   GET  /api/media/:id      -> sirve el archivo (para previews del panel)
 *   DELETE /api/media/:id    -> borra archivo + fila si nadie lo referencia
 *
 * El POST recibe JSON con base64 (la cookie de sesión viaja igual que en
 * el resto de la API). El GET lo usa el <img>/<video> del panel.
 */

import type { FastifyInstance } from 'fastify'
import {
  saveMediaFromBase64,
  readMediaBuffer,
  deleteMediaIfOrphan,
  resolveOwnedMedia,
  mediaSummary,
  MAX_MEDIA_BYTES
} from '../../lib/media.ts'
import { enforceRateLimit } from '../../lib/rateLimit.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:media')

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  // bodyLimit 75MB solo en /media (subida de multimedia como base64 en JSON).
  // Las demas rutas heredan el limite global pero /media lo necesita alto.
  app.post('/media', { bodyLimit: 75 * 1024 * 1024 }, async (req, reply) => {
    // Rate limit generico (30 acciones/min/admin) — frena floods de subida
    if (!enforceRateLimit(req.admin!.id, reply)) return

    const body = req.body as { base64?: string; mime_type?: string; file_name?: string } | undefined

    const result = saveMediaFromBase64({
      adminId: req.admin!.id,
      base64: String(body?.base64 ?? ''),
      mimeType: String(body?.mime_type ?? ''),
      fileName: body?.file_name
    })

    if (!result.ok) {
      return reply.code(400).send({ error: result.error })
    }

    return mediaSummary(result.media)
  })

  app.get<{ Params: { id: string } }>('/media/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const owned = resolveOwnedMedia(id, req.admin!.id)
    if (!owned.ok) {
      return reply.code(404).send({ error: owned.error })
    }

    try {
      const buffer = readMediaBuffer(owned.media)
      const mime = owned.media.mime_type.toLowerCase()
      // SVG/HTML/texto pueden ejecutar script si se renderizan en el origen
      // del panel: se sirven como descarga forzada, no inline.
      const risky = mime === 'image/svg+xml' || mime === 'image/svg' || mime.startsWith('text/')
      const safeName = owned.media.file_name.replace(/["\\\r\n]/g, '_')
      reply.header('Content-Type', mime)
      reply.header('Content-Length', String(buffer.length))
      reply.header('Content-Disposition', `${risky ? 'attachment' : 'inline'}; filename="${safeName}"`)
      reply.header('Cache-Control', 'private, max-age=86400')
      return reply.send(buffer)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg, id }, 'GET /media/:id')
      return reply.code(404).send({ error: 'El archivo no está disponible.' })
    }
  })

  app.delete<{ Params: { id: string } }>('/media/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const owned = resolveOwnedMedia(id, req.admin!.id)
    if (!owned.ok) {
      return reply.code(404).send({ error: owned.error })
    }
    deleteMediaIfOrphan(id)
    return { ok: true }
  })

  // Límite informativo para el frontend
  app.get('/media/limits', async () => ({ max_bytes: MAX_MEDIA_BYTES }))
}
