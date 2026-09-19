/**
 * Rutas API para publicación de mensajes.
 *
 *   POST /api/publish           -> envía texto/multimedia a destinos
 *   GET  /api/publish/history   -> últimos batches (cada uno = 1 publicación agrupada)
 *   GET  /api/publish/history/:id  -> detalles de un batch específico (destinos individuales)
 *
 * Formato: multipart/form-data (acepta tanto archivos como JSON fields)
 *   - text          (string, requerido salvo que haya media)
 *   - target_jids   (string JSON, opcional — default: todos los admin)
 *   - decorations   (string JSON, opcional — {forwarded: true, ...})
 *   - media         (file, opcional — imagen/video/audio/documento)
 *   - media_type    (string, opcional — forzar tipo: 'sticker' para .webp)
 */

import type { FastifyInstance } from 'fastify'
import { broadcastToTargets } from '../../lib/client.ts'
import { buildMessage, type DecorationOptions } from '../../lib/textDecorations.ts'
import { saveMediaFile, type MediaFile } from '../../lib/media.ts'
import {
  getAdminGroups,
  createPublishBatch,
  finalizePublishBatch,
  insertPublishLog,
  updatePublishLogStatus,
  getRecentPublishBatches,
  getPublishLogByBatch
} from '../../lib/db.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:publish')

interface ParsedForm {
  text?: string
  targetJids?: string[]
  decorations?: DecorationOptions
  media?: MediaFile
  forcedMediaType?: 'image' | 'video' | 'audio' | 'document' | 'sticker'
}

export async function registerPublishRoutes(app: FastifyInstance): Promise<void> {
  app.post('/publish', async (req, reply) => {
    let parsed: ParsedForm

    try {
      parsed = await parseRequest(req)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ err: msg }, 'Error parseando request de publicación.')
      return reply.code(400).send({ error: msg })
    }

    // Validar: al menos debe haber texto o media
    const hasText = parsed.text && parsed.text.trim().length > 0
    const hasMedia = !!parsed.media

    if (!hasText && !hasMedia) {
      return reply.code(400).send({ error: 'Debe haber al menos texto o un archivo multimedia.' })
    }

    // Resolver targets
    let targets: string[]
    if (parsed.targetJids && parsed.targetJids.length > 0) {
      targets = parsed.targetJids
    } else {
      const cached = getAdminGroups()
      targets = cached.map(g => g.jid)
    }

    if (targets.length === 0) {
      return reply.code(400).send({
        error: 'No hay destinos. Sincronizá grupos o canales primero.'
      })
    }

    // Construir el mensaje según el contenido
    let message: unknown
    let contentType: string = 'text'
    let mediaPath: string | null = null
    let mediaType: string | null = null
    let mediaName: string | null = null

    try {
      if (hasMedia && parsed.media) {
        // Mensaje con multimedia
        // Pasar path directo a baileys (sin cargar en memoria) para mejor estabilidad
        message = buildMessage({
          text: parsed.text,
          media: { url: parsed.media.path },
          mediaType: parsed.media.mediaType,
          fileName: parsed.media.originalName,
          mimeType: parsed.media.mimeType,
          decorations: parsed.decorations
        })
        contentType = parsed.media.mediaType
        mediaPath = parsed.media.relativePath
        mediaType = parsed.media.mediaType
        mediaName = parsed.media.originalName
      } else {
        // Sólo texto
        message = buildMessage({
          text: parsed.text,
          decorations: parsed.decorations
        })
        contentType = 'text'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'Error construyendo mensaje.')
      return reply.code(400).send({ error: 'Error construyendo mensaje: ' + msg })
    }

    // Crear batch
    const sentAt = Date.now()
    const decorationsJson = parsed.decorations ? JSON.stringify(parsed.decorations) : null

    const batchId = createPublishBatch({
      contentType,
      text: parsed.text ?? null,
      mediaPath,
      mediaType,
      mediaName,
      decorations: decorationsJson,
      buttons: null,
      totalTargets: targets.length,
      sentAt
    })

    // Crear entradas por destino (linkeadas al batch)
    const logIds: number[] = []
    for (const jid of targets) {
      const id = insertPublishLog({
        batch_id: batchId,
        target_jid: jid,
        content_type: contentType,
        text: parsed.text ?? null,
        media_path: mediaPath,
        status: 'pending',
        sent_at: sentAt,
        error: null
      })
      logIds.push(id)
    }

    log.info({
      targets: targets.length,
      hasMedia,
      hasDecorations: !!parsed.decorations,
      batchId
    }, 'Iniciando publicación.')

    // Broadcast
    const delayMs = 1500
    const results = await broadcastToTargets(targets, message as never, delayMs)

    // Actualizar estado por destino y el batch
    let sent = 0, failed = 0
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const logId = logIds[i]
      if (r.success) {
        updatePublishLogStatus(logId, 'sent', null)
        sent++
      } else {
        updatePublishLogStatus(logId, 'failed', r.error ?? 'unknown error')
        failed++
      }
    }

    finalizePublishBatch(batchId, sent, failed)

    log.info({ sent, failed, total: results.length, batchId }, 'Publicación completada.')

    return {
      batch_id: batchId,
      total: results.length,
      sent,
      failed,
      results
    }
  })

  /**
   * GET /api/publish/history -> lista de batches (1 entrada por publicación)
   */
  app.get('/publish/history', async (_req, reply) => {
    try {
      const batches = getRecentPublishBatches(50)
      return {
        count: batches.length,
        items: batches.map(b => ({
          id: b.id,
          sent_at: b.sent_at,
          content_type: b.content_type,
          text: b.text,
          media_name: b.media_name,
          media_type: b.media_type,
          decorations: b.decorations ? JSON.parse(b.decorations) : null,
          total_targets: b.total_targets,
          sent_count: b.sent_count,
          failed_count: b.failed_count,
          status: b.status
        }))
      }
    } catch (err) {
      log.error({ err }, 'GET /publish/history')
      return reply.code(500).send({ error: 'Error leyendo historial.' })
    }
  })

  /**
   * GET /api/publish/history/:id -> detalles de un batch (lista de destinos individuales)
   */
  app.get<{ Params: { id: string } }>('/publish/history/:id', async (req, reply) => {
    try {
      const batchId = parseInt(req.params.id, 10)
      if (isNaN(batchId)) {
        return reply.code(400).send({ error: 'ID inválido.' })
      }
      const details = getPublishLogByBatch(batchId)
      if (details.length === 0) {
        return reply.code(404).send({ error: 'Batch no encontrado.' })
      }
      return {
        batch_id: batchId,
        count: details.length,
        items: details
      }
    } catch (err) {
      log.error({ err }, 'GET /publish/history/:id')
      return reply.code(500).send({ error: 'Error leyendo batch.' })
    }
  })
}

/**
 * Parsea el request multipart y extrae todos los campos.
 */
async function parseRequest(req: import('fastify').FastifyRequest): Promise<ParsedForm> {
  const parts = req.parts()
  const parsed: ParsedForm = {}

  for await (const part of parts) {
    if (part.type === 'file') {
      // Archivo multimedia
      if (part.fieldname !== 'media') {
        log.warn({ fieldname: part.fieldname }, 'Campo file inesperado, se ignora.')
        continue
      }
      parsed.media = await saveMediaFile(part)
    } else {
      // Campo de texto
      const value = await part.value
      switch (part.fieldname) {
        case 'text':
          parsed.text = String(value || '')
          break
        case 'target_jids':
          try {
            parsed.targetJids = JSON.parse(String(value))
            if (!Array.isArray(parsed.targetJids)) {
              throw new Error('target_jids no es un array')
            }
          } catch (err) {
            throw new Error(`target_jids inválido: ${(err as Error).message}`)
          }
          break
        case 'decorations':
          try {
            parsed.decorations = JSON.parse(String(value))
          } catch {
            log.warn({ value }, 'decorations no es JSON válido — se ignora.')
          }
          break
        case 'media_type':
          // Forzar tipo de media (ej: 'sticker')
          if (['image', 'video', 'audio', 'document', 'sticker'].includes(String(value))) {
            parsed.forcedMediaType = String(value) as ParsedForm['forcedMediaType']
            // Si el media ya se guardó, actualizar su tipo
            if (parsed.media && parsed.forcedMediaType) {
              parsed.media.mediaType = parsed.forcedMediaType
            }
          }
          break
        default:
          // Campo desconocido, ignorar (incluye 'button' si llega de versión vieja)
          break
      }
    }
  }

  // Si llegó media_type después de media (orden de campos puede variar)
  if (parsed.forcedMediaType && parsed.media) {
    parsed.media.mediaType = parsed.forcedMediaType
  }

  return parsed
}

