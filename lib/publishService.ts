/**
 * Servicio de publicación: construye el mensaje (texto, multimedia o la
 * combinación de ambos), hace el broadcast por la cuenta indicada y deja
 * todo registrado en publish_batch / publish_log.
 *
 * Lo usan tanto el POST /api/publish (publicación inmediata) como el
 * scheduler (publicaciones programadas), para que el historial quede
 * consistente sin importar el origen del envío.
 *
 * Con imagen/video/documento el texto viaja como caption del mismo mensaje.
 * El audio no soporta caption en el protocolo: si hay texto, se manda el
 * audio y el texto como dos mensajes seguidos.
 */

import { broadcastToAccount } from './client.ts'
import { buildMessage, type DecorationOptions } from './textDecorations.ts'
import {
  createPublishBatch,
  insertPublishLog,
  updatePublishLogStatus,
  finalizePublishBatch,
  getMediaById,
  type MediaRow
} from './db.ts'
import { readMediaBuffer } from './media.ts'
import { logger } from './logger.ts'

const log = logger('publish')

export interface ExecuteOptions {
  adminId: number
  accountId: number
  targetJids: string[]
  text: string
  decorations?: DecorationOptions | null
  delayMs?: number
  scheduleId?: number | null
  /** Archivo multimedia ya guardado (id de la tabla media). */
  mediaId?: number | null
}

export interface ExecuteResult {
  batchId: number
  accountId: number
  total: number
  sent: number
  failed: number
  results: Array<{ jid: string; success: boolean; messageId?: string; error?: string }>
}

/**
 * Envía un texto (y multimedia opcional) a una lista de destinos con la
 * cuenta dada y registra el batch. Si la cuenta no está conectada o el
 * multimedia falta, igual queda el batch fallido en el historial
 * (transparente para el admin).
 */
export async function executeAndLog(opts: ExecuteOptions): Promise<ExecuteResult> {
  const sentAt = Date.now()
  const decorationsJson = opts.decorations ? JSON.stringify(opts.decorations) : null

  // Resolver multimedia (si falta el registro o el archivo, el batch falla con error claro)
  let media: MediaRow | null = null
  let mediaError: string | null = null
  if (opts.mediaId) {
    const row = getMediaById(opts.mediaId)
    if (!row) {
      mediaError = `El multimedia (id ${opts.mediaId}) no existe.`
    } else {
      media = row
    }
  }
  if (media && !mediaError) {
    try {
      readMediaBuffer(media)
    } catch (err) {
      mediaError = err instanceof Error ? err.message : String(err)
      media = null
    }
  }

  const contentType = media ? media.media_type : 'text'

  const batchId = createPublishBatch({
    contentType,
    text: opts.text || null,
    mediaPath: media ? media.storage_path : null,
    decorations: decorationsJson,
    totalTargets: opts.targetJids.length,
    sentAt,
    adminId: opts.adminId,
    accountId: opts.accountId,
    scheduleId: opts.scheduleId ?? null
  })

  const logIds: number[] = []
  for (const jid of opts.targetJids) {
    const id = insertPublishLog({
      batch_id: batchId,
      target_jid: jid,
      content_type: contentType,
      text: opts.text || null,
      media_path: media ? media.storage_path : null,
      status: 'pending',
      sent_at: sentAt,
      error: null
    })
    logIds.push(id)
  }

  log.info({ targets: opts.targetJids.length, accountId: opts.accountId, batchId, scheduleId: opts.scheduleId ?? null, media: media ? media.id : null }, 'Iniciando publicación.')

  let results: Array<{ jid: string; success: boolean; messageId?: string; error?: string }>

  if (mediaError) {
    log.error({ batchId, mediaError }, 'Publicación abortada por problema de multimedia.')
    results = opts.targetJids.map(jid => ({ jid, success: false, error: mediaError! }))
  } else if (media) {
    const buffer = readMediaBuffer(media)
    const base = buildMessage({
      text: opts.text,
      media: buffer,
      mediaType: media.media_type,
      mimeType: media.mime_type,
      fileName: media.file_name,
      decorations: opts.decorations ?? undefined
    })
    // Audio sin caption soportado: audio + texto como mensajes separados
    const messages = media.media_type === 'audio' && opts.text
      ? [base, buildMessage({ text: opts.text, decorations: opts.decorations ?? undefined })]
      : [base]
    results = await broadcastToAccount(opts.accountId, opts.targetJids, messages, opts.delayMs ?? 1500)
  } else {
    const message = buildMessage({
      text: opts.text,
      decorations: opts.decorations ?? undefined
    })
    results = await broadcastToAccount(opts.accountId, opts.targetJids, [message], opts.delayMs ?? 1500)
  }

  let sent = 0
  let failed = 0
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
    batchId,
    accountId: opts.accountId,
    total: results.length,
    sent,
    failed,
    results
  }
}
