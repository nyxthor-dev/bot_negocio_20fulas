/**
 * Rutas API para publicación inmediata de mensajes.
 *
 *   POST /api/publish           -> envía a una o varias cuentas (1 batch por cuenta)
 *   GET  /api/publish/history   -> últimos batches del admin (cada uno = 1 envío agrupado)
 *   GET  /api/publish/history/:id -> detalles de un batch (destinos individuales)
 *
 * El body acepta items por cuenta, cada uno con sus propios destinos, su
 * propio texto (o multimedia, o ambos combinados):
 *
 *   {
 *     "items": [
 *       { "account_id": 1, "text": "...", "target_jids": ["...@g.us"] },
 *       { "account_id": 2, "media_id": 7, "text": "caption", "target_jids": [...] },
 *       { "account_id": 3, "media": { "base64": "...", "mime_type": "image/jpeg" }, "target_jids": [...] }
 *     ],
 *     "delay_ms": 1500,
 *     "assign": { "123-456@g.us": 2 }
 *   }
 *
 * Si el mismo grupo/canal aparece seleccionado en varias cuentas, sólo lo
 * envía una: la cuenta elegida en `assign` para ese jid, o —si no hay
 * elección— la primera (dedupeCrossAccount). El resto queda en la respuesta
 * como "skipped" para que el panel lo muestre con claridad.
 */

import type { FastifyInstance } from 'fastify'
import type { DecorationOptions } from '../../lib/textDecorations.ts'
import { getAccount, getRecentPublishBatches, getPublishLogByBatch, getPublishBatchById, deleteMediaRow } from '../../lib/db.ts'
import { executeAndLog } from '../../lib/publishService.ts'
import { dedupeCrossAccount } from '../../lib/dedupe.ts'
import { saveMediaFromBase64, resolveOwnedMedia } from '../../lib/media.ts'
import { invalidJid, sanitizeDecorations, MAX_TEXT_LEN } from '../../lib/messageValidation.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:publish')

/** Máximo de destinos por item (frena floods en un solo request). */
const MAX_JIDS_PER_ITEM = 200

interface InlineMediaInput {
  base64?: string
  mime_type?: string
  file_name?: string
}

interface PublishItem {
  account_id?: number
  target_jids?: string[]
  text?: string
  decorations?: Record<string, unknown>
  /** Multimedia ya subida con POST /api/media */
  media_id?: number
  /** Multimedia nueva en el mismo request (se guarda y se referencia) */
  media?: InlineMediaInput
}

interface PublishBody {
  items?: PublishItem[]
  delay_ms?: number
  /** Elección del usuario: { jid → account_id } para destinos duplicados. */
  assign?: Record<string, unknown>
}

export async function registerPublishRoutes(app: FastifyInstance): Promise<void> {
  app.post('/publish', async (req, reply) => {
    const body = req.body as PublishBody | undefined
    const items = body?.items

    if (!Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: 'Se requiere "items" con al menos un envío.' })
    }
    if (items.length > 10) {
      return reply.code(400).send({ error: 'Máximo 10 items (cuentas) por publicación.' })
    }

    // Validación completa ANTES de enviar nada
    const normalized: Array<{ accountId: number; jids: string[]; text: string; decorations: DecorationOptions | null; mediaId: number | null }> = []
    const pendingInline: Array<{ index: number; media: InlineMediaInput }> = []
    const savedInlineIds: number[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const accountId = Number(item?.account_id)

      if (!Number.isInteger(accountId)) {
        return reply.code(400).send({ error: `Item ${i + 1}: falta account_id.` })
      }
      const account = getAccount(accountId)
      if (!account || account.admin_id !== req.admin!.id) {
        return reply.code(400).send({ error: `Item ${i + 1}: la cuenta no existe o no es tuya.` })
      }

      const text = String(item?.text ?? '').trim()
      if (text.length > MAX_TEXT_LEN) {
        return reply.code(400).send({ error: `Item ${i + 1}: el texto supera el máximo de ${MAX_TEXT_LEN} caracteres.` })
      }

      const jids = (item?.target_jids ?? []).filter(j => typeof j === 'string' && j.length > 0)
      if (jids.length === 0) {
        return reply.code(400).send({ error: `Item ${i + 1}: elegí al menos un destino.` })
      }
      if (jids.length > MAX_JIDS_PER_ITEM) {
        return reply.code(400).send({ error: `Item ${i + 1}: máximo ${MAX_JIDS_PER_ITEM} destinos por cuenta.` })
      }
      const badJid = invalidJid(jids, `Item ${i + 1}`)
      if (badJid) {
        return reply.code(400).send({ error: badJid })
      }

      // Multimedia: id ya subido, o base64 inline (se guarda recién después
      // de validar TODO, para no dejar archivos huérfanos si un item falla)
      let mediaId: number | null = null
      if (item?.media_id !== undefined && item?.media_id !== null) {
        const mid = Number(item.media_id)
        if (!Number.isInteger(mid)) {
          return reply.code(400).send({ error: `Item ${i + 1}: media_id inválido.` })
        }
        const owned = resolveOwnedMedia(mid, req.admin!.id)
        if (!owned.ok) {
          return reply.code(400).send({ error: `Item ${i + 1}: ${owned.error}` })
        }
        mediaId = mid
      } else if (item?.media && typeof item.media === 'object') {
        pendingInline.push({ index: i, media: item.media })
      }

      if (!text && mediaId === null && !(item?.media && typeof item.media === 'object')) {
        return reply.code(400).send({ error: `Item ${i + 1}: escribí un texto o adjuntá multimedia.` })
      }

      normalized.push({ accountId, jids, text, decorations: sanitizeDecorations(item.decorations), mediaId })
    }

    // Ya validado todo el body: recién acá se guarda la multimedia inline.
    // Si un guardo falla, se limpian los anteriores (sin huérfanas en disco).
    for (const p of pendingInline) {
      const saved = saveMediaFromBase64({
        adminId: req.admin!.id,
        base64: String(p.media.base64 ?? ''),
        mimeType: String(p.media.mime_type ?? ''),
        fileName: p.media.file_name
      })
      if (!saved.ok) {
        for (const m of savedInlineIds) deleteMediaRow(m)
        return reply.code(400).send({ error: `Item ${p.index + 1}: ${saved.error}` })
      }
      savedInlineIds.push(saved.media.id)
      normalized[p.index].mediaId = saved.media.id
    }

    // Un mismo jid repetido entre DOS items de la MISMA cuenta enviaría doble:
    // se rechaza con error claro en vez de perder el destino en silencio.
    const seenSame = new Map<string, number>()
    for (const n of normalized) {
      for (const jid of n.jids) {
        const prev = seenSame.get(jid)
        if (prev !== undefined && prev === n.accountId) {
          return reply.code(400).send({ error: `El destino ${jid} está repetido en dos items de la misma cuenta.` })
        }
        seenSame.set(jid, n.accountId)
      }
    }

    const delayMs = Number(body?.delay_ms ?? 1500)
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) {
      return reply.code(400).send({ error: 'delay_ms debe estar entre 0 y 60000 ms.' })
    }

    // Elección del usuario para duplicados: { jid → account_id }.
    // Se aceptan sólo entradas cuyo account_id participe en este envío
    // (si no, el dedupe cae al orden determinista).
    const participantIds = new Set(normalized.map(n => n.accountId))
    const assign: Record<string, number> = {}
    if (body?.assign && typeof body.assign === 'object' && !Array.isArray(body.assign)) {
      for (const [jid, accId] of Object.entries(body.assign)) {
        const num = Number(accId)
        if (typeof jid === 'string' && jid.length > 0 && jid.length <= 200 && Number.isInteger(num) && participantIds.has(num)) {
          assign[jid] = num
        }
      }
    }

    // Deduplicación entre cuentas: si varias cuentas tienen el mismo
    // grupo/canal elegido, sólo lo envía la elegida (o la primera).
    const { items: deduped, skipped } = dedupeCrossAccount(normalized, assign)
    if (skipped.length > 0) {
      log.info({ skipped: skipped.map(s => ({ accountId: s.accountId, jid: s.jid, keptBy: s.keptByAccountId })) }, `Deduplicados ${skipped.length} destino(s) repetidos entre cuentas.`)
    }

    // Envío por cuenta (cada una genera su propio batch en el historial)
    const results = []
    for (const item of deduped) {
      if (item.jids.length === 0) continue // todos sus destinos ya los cubre otra cuenta
      const r = await executeAndLog({
        adminId: req.admin!.id,
        accountId: item.accountId,
        targetJids: item.jids,
        text: item.text,
        decorations: item.decorations,
        delayMs,
        scheduleId: null,
        mediaId: item.mediaId
      })
      results.push(r)
    }

    const sent = results.reduce((acc, r) => acc + r.sent, 0)
    const failed = results.reduce((acc, r) => acc + r.failed, 0)
    const total = results.reduce((acc, r) => acc + r.total, 0)

    return {
      ok: failed === 0,
      total,
      sent,
      failed,
      batches: results,
      skipped_total: skipped.length,
      skipped: skipped.map(s => ({
        account_id: s.accountId,
        jid: s.jid,
        kept_by: s.keptByAccountId
      }))
    }
  })

  /**
   * GET /publish/history -> lista de batches (1 entrada por envío por cuenta)
   */
  app.get('/publish/history', async (req, reply) => {
    try {
      const batches = getRecentPublishBatches(50, req.admin!.id)
      return {
        count: batches.length,
        items: batches.map(b => ({
          id: b.id,
          sent_at: b.sent_at,
          content_type: b.content_type,
          text: b.text,
          decorations: b.decorations ? JSON.parse(b.decorations) : null,
          total_targets: b.total_targets,
          sent_count: b.sent_count,
          failed_count: b.failed_count,
          status: b.status,
          account_id: b.account_id,
          schedule_id: b.schedule_id
        }))
      }
    } catch (err) {
      log.error({ err }, 'GET /publish/history')
      return reply.code(500).send({ error: 'Error leyendo historial.' })
    }
  })

  /**
   * GET /publish/history/:id -> detalles de un batch (lista de destinos individuales)
   */
  app.get<{ Params: { id: string } }>('/publish/history/:id', async (req, reply) => {
    try {
      const batchId = parseInt(req.params.id, 10)
      if (isNaN(batchId)) {
        return reply.code(400).send({ error: 'ID inválido.' })
      }
      // Ownership: cada admin sólo ve los detalles de SUS batches
      // (igual que GET /publish/history, que filtra por admin_id).
      const batch = getPublishBatchById(batchId, req.admin!.id)
      if (!batch) {
        return reply.code(404).send({ error: 'Batch no encontrado.' })
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
