/**
 * Rutas de plantillas guardadas (publicaciones para reciclar).
 *
 *   GET    /api/templates        -> lista las del admin
 *   POST   /api/templates        -> guarda una nueva { name, text, decorations, media_id? }
 *   PUT    /api/templates/:id    -> actualiza texto/nombre/decoraciones/multimedia
 *   DELETE /api/templates/:id    -> elimina (y borra multimedia huérfana)
 *   POST   /api/templates/:id/publish -> publica la plantilla YA (items con destinos)
 *
 * Con multimedia el texto pasa a ser el caption (opcional): puede haber
 * plantilla de sólo imagen, o imagen+texto combinados.
 */

import type { FastifyInstance } from 'fastify'
import type { DecorationOptions } from '../../lib/textDecorations.ts'
import {
  insertTemplate,
  updateTemplate,
  deleteTemplate,
  listTemplates,
  getTemplate,
  getAccount,
  getMediaById
} from '../../lib/db.ts'
import { deleteMediaIfOrphan, mediaSummary, resolveOwnedMedia } from '../../lib/media.ts'
import { executeAndLog } from '../../lib/publishService.ts'
import { dedupeCrossAccount } from '../../lib/dedupe.ts'
import { invalidJid, MAX_TEXT_LEN } from '../../lib/messageValidation.ts'
import { enforceRateLimit } from '../../lib/rateLimit.ts'
import { logger } from '../../lib/logger.ts'

/** Máximo de destinos por item (frena floods en un solo request). */
const MAX_JIDS_PER_ITEM = 200

/** Tope de entradas del objeto assign (anti-DoS por loop de validacion). */
const MAX_ASSIGN_ENTRIES = 200

const log = logger('routes:templates')

interface TemplateBody {
  name?: string
  text?: string
  decorations?: DecorationOptions
  media_id?: number | null
}

/** Valida el body común de POST/PUT. Devuelve error o los campos listos. */
function validateTemplateBody(body: TemplateBody | undefined): { ok: true; name: string; text: string; decorations: string | null; mediaId: number | null } | { ok: false; error: string } {
  const name = String(body?.name ?? '').trim()
  const text = String(body?.text ?? '').trim()

  if (!name || name.length > 80) {
    return { ok: false, error: 'El nombre es requerido (máx 80 caracteres).' }
  }

  const mediaId = body?.media_id === null || body?.media_id === undefined ? null : Number(body.media_id)
  if (mediaId !== null && !Number.isInteger(mediaId)) {
    return { ok: false, error: 'media_id inválido.' }
  }

  if (!text && mediaId === null) {
    return { ok: false, error: 'Escribí un texto o adjuntá multimedia.' }
  }

  const decorations = body?.decorations ? JSON.stringify(body.decorations) : null
  return { ok: true, name, text, decorations, mediaId }
}

function serializeTemplate(t: ReturnType<typeof listTemplates>[number]) {
  const media = t.media_id ? getMediaById(t.media_id) : undefined
  // Parseo tolerante: un registro con decoraciones corruptas no tumba el listado
  let decorations: unknown = null
  if (t.decorations) {
    try { decorations = JSON.parse(t.decorations) } catch { decorations = null }
  }
  return {
    id: t.id,
    name: t.name,
    text: t.text,
    decorations,
    media: media ? mediaSummary(media) : null,
    created_at: t.created_at,
    updated_at: t.updated_at
  }
}

export async function registerTemplatesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/templates', async (req, reply) => {
    try {
      const rows = listTemplates(req.admin!.id)
      return {
        count: rows.length,
        items: rows.map(serializeTemplate)
      }
    } catch (err) {
      log.error({ err }, 'GET /templates')
      return reply.code(500).send({ error: 'Error listando plantillas.' })
    }
  })

  app.post('/templates', async (req, reply) => {
    const body = req.body as TemplateBody | undefined
    const valid = validateTemplateBody(body)
    if (!valid.ok) {
      return reply.code(400).send({ error: valid.error })
    }

    if (valid.mediaId !== null) {
      const owned = resolveOwnedMedia(valid.mediaId, req.admin!.id)
      if (!owned.ok) return reply.code(400).send({ error: owned.error })
    }

    const id = insertTemplate(req.admin!.id, valid.name, valid.text, valid.decorations, valid.mediaId)
    log.info({ id, name: valid.name, media: valid.mediaId, admin: req.admin!.username }, 'Plantilla guardada.')
    return { id, name: valid.name }
  })

  app.put<{ Params: { id: string } }>('/templates/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const existing = getTemplate(id, req.admin!.id)
    if (!existing) return reply.code(404).send({ error: 'Plantilla no encontrada.' })

    const body = req.body as TemplateBody | undefined
    const valid = validateTemplateBody(body)
    if (!valid.ok) {
      return reply.code(400).send({ error: valid.error })
    }

    if (valid.mediaId !== null) {
      const owned = resolveOwnedMedia(valid.mediaId, req.admin!.id)
      if (!owned.ok) return reply.code(400).send({ error: owned.error })
    }

    updateTemplate(id, req.admin!.id, valid.name, valid.text, valid.decorations, valid.mediaId)
    deleteMediaIfOrphan(existing.media_id)
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/templates/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const existing = getTemplate(id, req.admin!.id)
    if (!existing) return reply.code(404).send({ error: 'Plantilla no encontrada.' })

    deleteTemplate(id, req.admin!.id)
    deleteMediaIfOrphan(existing.media_id)
    return { ok: true }
  })

  // Publicar una plantilla al instante: items = [{ account_id, target_jids }]
  // Mismas validaciones que POST /api/publish: ownership de las cuentas,
  // jids válidos, delay acotado y dedupe entre cuentas (con assign).
  app.post<{ Params: { id: string } }>('/templates/:id/publish', async (req, reply) => {
    // Rate limit estricto para publicaciones (10/min/admin) — igual que POST /api/publish
    if (!enforceRateLimit(req.admin!.id, reply, 'publish')) return

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const template = getTemplate(id, req.admin!.id)
    if (!template) return reply.code(404).send({ error: 'Plantilla no encontrada.' })

    const body = req.body as {
      items?: Array<{ account_id?: number; target_jids?: unknown[] }>
      delay_ms?: number
      assign?: Record<string, unknown>
    } | undefined

    // Validación completa ANTES de enviar nada (igual que POST /api/publish)
    const normalized: Array<{ accountId: number; jids: string[] }> = []
    const rawItems = Array.isArray(body?.items) ? body!.items : []
    if (rawItems.length === 0) {
      return reply.code(400).send({ error: 'Se requiere al menos un item { account_id, target_jids }.' })
    }
    if (rawItems.length > 10) {
      return reply.code(400).send({ error: 'Máximo 10 items (cuentas) por publicación.' })
    }
    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i]
      const accountId = Number(item?.account_id)
      if (!Number.isInteger(accountId)) {
        return reply.code(400).send({ error: `Item ${i + 1}: falta account_id.` })
      }
      // Ownership: la cuenta tiene que existir y ser del admin logueado
      const account = getAccount(accountId)
      if (!account || account.admin_id !== req.admin!.id) {
        return reply.code(400).send({ error: `Item ${i + 1}: la cuenta no existe o no es tuya.` })
      }
      const jids = (item?.target_jids ?? []).filter((j): j is string => typeof j === 'string' && j.length > 0)
      if (jids.length === 0) {
        return reply.code(400).send({ error: `Item ${i + 1}: elegí al menos un destino.` })
      }
      if (jids.length > MAX_JIDS_PER_ITEM) {
        return reply.code(400).send({ error: `Item ${i + 1}: máximo ${MAX_JIDS_PER_ITEM} destinos por cuenta.` })
      }
      const badJid = invalidJid(jids, `Item ${i + 1}`)
      if (badJid) return reply.code(400).send({ error: badJid })
      normalized.push({ accountId, jids })
    }

    // Un mismo jid repetido entre DOS items de la MISMA cuenta enviaría doble:
    // se rechaza con error claro en vez de perder el destino en silencio.
    const seen = new Map<string, number>()
    for (const n of normalized) {
      for (const jid of n.jids) {
        const prev = seen.get(jid)
        if (prev !== undefined && prev === n.accountId) {
          return reply.code(400).send({ error: `El destino ${jid} está repetido en dos items de la misma cuenta.` })
        }
        seen.set(jid, n.accountId)
      }
    }

    const delayMs = Number(body?.delay_ms ?? 1500)
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) {
      return reply.code(400).send({ error: 'delay_ms debe estar entre 0 y 60000 ms.' })
    }

    // Elección del usuario para duplicados: { jid → account_id }, igual que
    // POST /api/publish. Entradas inválidas caen al orden determinista.
    const participantIds = new Set(normalized.map(n => n.accountId))
    const assign: Record<string, number> = {}
    if (body?.assign && typeof body.assign === 'object' && !Array.isArray(body.assign)) {
      const assignKeys = Object.keys(body.assign)
      if (assignKeys.length > MAX_ASSIGN_ENTRIES) {
        return reply.code(400).send({ error: `assign admite máximo ${MAX_ASSIGN_ENTRIES} entradas.` })
      }
      for (const [jid, accId] of Object.entries(body.assign)) {
        const num = Number(accId)
        if (typeof jid === 'string' && jid.length > 0 && jid.length <= 200 && Number.isInteger(num) && participantIds.has(num)) {
          assign[jid] = num
        }
      }
    }

    // Deduplicación entre cuentas: si varias tienen el mismo destino, sólo
    // lo envía la elegida (o la primera).
    const { items: deduped, skipped } = dedupeCrossAccount(normalized, assign)

    let decorations: DecorationOptions | null = null
    if (template.decorations) {
      try { decorations = JSON.parse(template.decorations) } catch { decorations = null }
    }

    const text = template.text.length > MAX_TEXT_LEN ? template.text.slice(0, MAX_TEXT_LEN) : template.text

    const results = []
    for (const item of deduped) {
      if (item.jids.length === 0) continue // todos sus destinos ya los cubre otra cuenta
      const r = await executeAndLog({
        adminId: req.admin!.id,
        accountId: item.accountId,
        targetJids: item.jids,
        text,
        decorations,
        delayMs,
        scheduleId: null,
        mediaId: template.media_id
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
}
