/**
 * Rutas de programaciones (publicaciones automáticas).
 *
 *   GET    /api/schedules            -> lista las del admin (con sus mensajes)
 *   POST   /api/schedules            -> crea { name, tipo, horarios, messages[] }
 *   PUT    /api/schedules/:id        -> edita (reemplaza horario y mensajes)
 *   DELETE /api/schedules/:id        -> elimina
 *   POST   /api/schedules/:id/pause  -> pausa
 *   POST   /api/schedules/:id/resume -> reanuda (recalcula próximo vencimiento)
 *   POST   /api/schedules/:id/run    -> ejecuta ahora (sin esperar el horario)
 *
 * Horarios:
 *  - once: fecha y hora puntual (scheduled_at)
 *  - daily / weekly / monthly: recur_times = [minutos 0-1439] con VARIOS
 *    horarios por día (la publicación se repite varias veces al día)
 *  - interval: interval_minutes + ventana opcional window_start/window_end
 *    (ej: cada 90 minutos entre las 09:00 y las 18:00)
 *
 * Cada mensaje elige cuenta, destinos, texto y multimedia opcional (el
 * texto va como caption de imagen/video/documento).
 */

import type { FastifyInstance } from 'fastify'
import {
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  listSchedules,
  getSchedule,
  insertScheduleMessage,
  listScheduleMessages,
  deleteScheduleMessages,
  setScheduleStatus,
  getAccount,
  getMediaById,
  withTransaction,
  type ScheduleType
} from '../../lib/db.ts'
import { resolveNextRun, computeNextRun, parseTimes, runScheduleNow } from '../../lib/scheduler.ts'
import { deleteMediaIfOrphan, mediaSummary, resolveOwnedMedia } from '../../lib/media.ts'
import { invalidJid, sanitizeDecorations, MAX_TEXT_LEN } from '../../lib/messageValidation.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:schedules')

interface ScheduleMessageInput {
  account_id?: number
  target_jids?: string[]
  text?: string
  decorations?: Record<string, unknown>
  media_id?: number | null
}

interface ScheduleBody {
  name?: string
  sched_type?: string
  scheduled_at?: number | null
  recur_time?: number | null
  recur_times?: number[] | null
  recur_dow?: number | null
  recur_dom?: number | null
  interval_minutes?: number | null
  window_start?: number | null
  window_end?: number | null
  tz_offset_min?: number
  status?: string
  messages?: ScheduleMessageInput[]
  /** Elección de cuenta para destinos duplicados entre mensajes: { jid → account_id }. */
  assign_map?: Record<string, unknown>
}

function parseType(raw: unknown): ScheduleType | null {
  const t = String(raw ?? '')
  if (t === 'once' || t === 'daily' || t === 'weekly' || t === 'monthly' || t === 'interval') return t
  return null
}

/** Valida y normaliza los mensajes de una programación. Devuelve error o lista lista para insertar. */
function validateMessages(
  adminId: number,
  raw: ScheduleMessageInput[] | undefined
): { ok: true; messages: Array<{ account_id: number; target_jids: string[]; text: string; decorations: string | null; media_id: number | null }> } | { ok: false; error: string } {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'La programación necesita al menos un mensaje.' }
  }
  if (raw.length > 10) {
    return { ok: false, error: 'Máximo 10 mensajes por programación.' }
  }

  const messages = []
  const seenJidAccount = new Map<string, number>()
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i]
    const accountId = Number(m?.account_id)
    if (!Number.isInteger(accountId)) {
      return { ok: false, error: `Mensaje ${i + 1}: falta la cuenta.` }
    }
    const account = getAccount(accountId)
    if (!account || account.admin_id !== adminId) {
      return { ok: false, error: `Mensaje ${i + 1}: la cuenta no existe o no es tuya.` }
    }
    const jids = (m?.target_jids ?? []).filter(j => typeof j === 'string' && j.length > 0)
    if (jids.length === 0) {
      return { ok: false, error: `Mensaje ${i + 1}: elegí al menos un destino.` }
    }
    if (jids.length > 200) {
      return { ok: false, error: `Mensaje ${i + 1}: máximo 200 destinos.` }
    }
    const badJid = invalidJid(jids, `Mensaje ${i + 1}`)
    if (badJid) {
      return { ok: false, error: badJid }
    }
    // El mismo jid en DOS mensajes de la MISMA cuenta enviaría doble: el
    // dedupe entre cuentas no aplica acá (es la misma cuenta), así que se
    // rechaza con error claro en vez de perder el destino en silencio.
    for (const jid of jids) {
      const prev = seenJidAccount.get(jid)
      if (prev !== undefined && prev === accountId) {
        return { ok: false, error: `El destino ${jid} está en dos mensajes de la misma cuenta. Elegí una sola vez el destino por cuenta.` }
      }
      seenJidAccount.set(jid, accountId)
    }
    const text = String(m?.text ?? '').trim()
    if (text.length > MAX_TEXT_LEN) {
      return { ok: false, error: `Mensaje ${i + 1}: el texto supera el máximo de ${MAX_TEXT_LEN} caracteres.` }
    }
    const mediaId = m?.media_id === null || m?.media_id === undefined ? null : Number(m.media_id)
    if (mediaId !== null && !Number.isInteger(mediaId)) {
      return { ok: false, error: `Mensaje ${i + 1}: media_id inválido.` }
    }
    if (!text && mediaId === null) {
      return { ok: false, error: `Mensaje ${i + 1}: escribí un texto o adjuntá multimedia.` }
    }
    if (mediaId !== null) {
      const owned = resolveOwnedMedia(mediaId, adminId)
      if (!owned.ok) {
        return { ok: false, error: `Mensaje ${i + 1}: ${owned.error}` }
      }
    }
    const decorations = sanitizeDecorations(m?.decorations)
    messages.push({ account_id: accountId, target_jids: jids, text, decorations: decorations ? JSON.stringify(decorations) : null, media_id: mediaId })
  }

  return { ok: true, messages }
}

/**
 * Valida y serializa la elección de cuenta para destinos duplicados.
 * Sólo acepta entradas cuyo jid esté efectivamente repetido entre mensajes
 * y cuyo account_id participe en la programación con ese destino.
 */
function validateAssignMap(
  raw: Record<string, unknown> | undefined,
  messages: Array<{ account_id: number; target_jids: string[] }>
): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  // Cuenta de los mensajes + jids repetidos entre mensajes distintos
  const ownerCount = new Map<string, Set<number>>()
  for (const m of messages) {
    for (const jid of new Set(m.target_jids)) {
      if (!ownerCount.has(jid)) ownerCount.set(jid, new Set())
      ownerCount.get(jid)!.add(m.account_id)
    }
  }

  const out: Record<string, number> = {}
  for (const [jid, accId] of Object.entries(raw)) {
    const num = Number(accId)
    if (typeof jid !== 'string' || jid.length === 0 || jid.length > 200) continue
    if (!Number.isInteger(num)) continue
    const owners = ownerCount.get(jid)
    if (!owners || owners.size < 2 || !owners.has(num)) continue
    out[jid] = num
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null
}

/** JSON.parse tolerante: un registro corrupto no puede tumbar el listado entero. */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function serializeSchedule(s: ReturnType<typeof listSchedules>[number]) {
  const msgs = listScheduleMessages(s.id)
  const times = parseTimes(s.recur_times, s.recur_time)
  return {
    id: s.id,
    name: s.name,
    sched_type: s.sched_type,
    scheduled_at: s.scheduled_at,
    recur_time: s.recur_time,
    recur_times: times,
    recur_dow: s.recur_dow,
    recur_dom: s.recur_dom,
    interval_minutes: s.interval_minutes,
    window_start: s.window_start,
    window_end: s.window_end,
    tz_offset_min: s.tz_offset_min,
    status: s.status,
    created_at: s.created_at,
    updated_at: s.updated_at,
    last_run_at: s.last_run_at,
    next_run_at: s.next_run_at,
    assign_map: safeJsonParse(s.assign_map, null),
    messages: msgs.map(m => {
      const media = m.media_id ? getMediaById(m.media_id) : undefined
      return {
        id: m.id,
        account_id: m.account_id,
        target_jids: safeJsonParse(m.target_jids, []),
        text: m.text,
        decorations: safeJsonParse(m.decorations, null),
        media: media ? mediaSummary(media) : null
      }
    })
  }
}

/** Normaliza los horarios del body (acepta array nuevo o recur_time viejo). */
function collectTimes(body: ScheduleBody | undefined): number[] {
  let times: number[] = []
  if (Array.isArray(body?.recur_times)) {
    times = body.recur_times.map(Number).filter(t => Number.isInteger(t) && t >= 0 && t <= 1439)
  }
  if (times.length === 0 && body?.recur_time !== null && body?.recur_time !== undefined) {
    const t = Number(body.recur_time)
    if (Number.isInteger(t) && t >= 0 && t <= 1439) times = [t]
  }
  return Array.from(new Set(times)).sort((a, b) => a - b)
}

/** Guarda los mensajes de una programación nueva o editada. */
function saveScheduleMessages(id: number, messages: Array<{ account_id: number; target_jids: string[]; text: string; decorations: string | null; media_id: number | null }>): void {
  for (const m of messages) {
    insertScheduleMessage(id, m.account_id, m.target_jids, m.text, m.decorations, m.media_id)
  }
}

/**
 * Reemplaza los mensajes de una programación conservando la multimedia que
 * los mensajes nuevos siguen usando y limpiando la que quedó huérfana.
 */
function replaceScheduleMessages(id: number, messages: Array<{ account_id: number; target_jids: string[]; text: string; decorations: string | null; media_id: number | null }>): void {
  const keepMediaIds = new Set(messages.filter(m => m.media_id !== null).map(m => m.media_id))
  const oldMessages = listScheduleMessages(id)
  deleteScheduleMessages(id)
  for (const m of oldMessages) {
    if (m.media_id && !keepMediaIds.has(m.media_id)) deleteMediaIfOrphan(m.media_id)
  }
  saveScheduleMessages(id, messages)
}

export async function registerSchedulesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/schedules', async (req, reply) => {
    try {
      const rows = listSchedules(req.admin!.id)
      return { count: rows.length, items: rows.map(serializeSchedule) }
    } catch (err) {
      log.error({ err }, 'GET /schedules')
      return reply.code(500).send({ error: 'Error listando programaciones.' })
    }
  })

  app.post('/schedules', async (req, reply) => {
    const body = req.body as ScheduleBody | undefined
    const name = String(body?.name ?? '').trim()
    const schedType = parseType(body?.sched_type)

    if (!name || name.length > 80) {
      return reply.code(400).send({ error: 'El nombre es requerido (máx 80 caracteres).' })
    }
    if (!schedType) {
      return reply.code(400).send({ error: 'Tipo inválido: once, daily, weekly, monthly o interval.' })
    }

    const next = resolveNextRun({
      sched_type: schedType,
      scheduled_at: body?.scheduled_at ?? null,
      recur_time: body?.recur_time ?? null,
      recur_times: collectTimes(body),
      recur_dow: body?.recur_dow ?? null,
      recur_dom: body?.recur_dom ?? null,
      interval_minutes: body?.interval_minutes ?? null,
      window_start: body?.window_start ?? null,
      window_end: body?.window_end ?? null,
      tz_offset_min: body?.tz_offset_min ?? 0,
      status: 'active'
    })
    if (!next.ok) {
      return reply.code(400).send({ error: next.error })
    }

    const messages = validateMessages(req.admin!.id, body?.messages)
    if (!messages.ok) {
      return reply.code(400).send({ error: messages.error })
    }
    const assignMapJson = validateAssignMap(body?.assign_map, messages.messages)

    const times = collectTimes(body)
    const recurTimesJson = times.length > 0 ? JSON.stringify(times) : null
    const recurTimeLegacy = times.length > 0 ? times[0] : null

    // Transacción: la programación y sus mensajes se guardan juntos o nada
    const id = withTransaction(() => {
      const sid = insertSchedule({
        admin_id: req.admin!.id,
        name,
        sched_type: schedType,
        scheduled_at: body?.scheduled_at ?? null,
        recur_time: recurTimeLegacy,
        recur_times: recurTimesJson,
        recur_dow: body?.recur_dow ?? null,
        recur_dom: body?.recur_dom ?? null,
        interval_minutes: body?.interval_minutes ?? null,
        window_start: body?.window_start ?? null,
        window_end: body?.window_end ?? null,
        tz_offset_min: body?.tz_offset_min ?? 0,
        next_run_at: next.next_run_at,
        assign_map: assignMapJson
      })

      saveScheduleMessages(sid, messages.messages)
      return sid
    })

    log.info({ id, name, type: schedType, times: times.length, interval: body?.interval_minutes ?? null, messages: messages.messages.length, admin: req.admin!.username }, 'Programación creada.')
    return { id, name, next_run_at: next.next_run_at }
  })

  app.put<{ Params: { id: string } }>('/schedules/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const existing = getSchedule(id, req.admin!.id)
    if (!existing) return reply.code(404).send({ error: 'Programación no encontrada.' })

    const body = req.body as ScheduleBody | undefined
    const name = String(body?.name ?? '').trim()
    const schedType = parseType(body?.sched_type)

    if (!name || name.length > 80) {
      return reply.code(400).send({ error: 'El nombre es requerido (máx 80 caracteres).' })
    }
    if (!schedType) {
      return reply.code(400).send({ error: 'Tipo inválido: once, daily, weekly, monthly o interval.' })
    }

    const requestedStatus = body && 'status' in body && (body as { status?: string }).status === 'paused' ? 'paused' as const : 'active'

    const next = resolveNextRun({
      sched_type: schedType,
      scheduled_at: body?.scheduled_at ?? null,
      recur_time: body?.recur_time ?? null,
      recur_times: collectTimes(body),
      recur_dow: body?.recur_dow ?? null,
      recur_dom: body?.recur_dom ?? null,
      interval_minutes: body?.interval_minutes ?? null,
      window_start: body?.window_start ?? null,
      window_end: body?.window_end ?? null,
      tz_offset_min: body?.tz_offset_min ?? 0,
      status: requestedStatus
    })
    if (!next.ok) {
      return reply.code(400).send({ error: next.error })
    }

    const messages = validateMessages(req.admin!.id, body?.messages)
    if (!messages.ok) {
      return reply.code(400).send({ error: messages.error })
    }
    const assignMapJson = validateAssignMap(body?.assign_map, messages.messages)

    const times = collectTimes(body)
    const recurTimesJson = times.length > 0 ? JSON.stringify(times) : null
    const recurTimeLegacy = times.length > 0 ? times[0] : null

    // Transacción: cabecera editada + mensajes reemplazados van juntos
    withTransaction(() => {
      updateSchedule(id, req.admin!.id, {
        name,
        sched_type: schedType,
        scheduled_at: body?.scheduled_at ?? null,
        recur_time: recurTimeLegacy,
        recur_times: recurTimesJson,
        recur_dow: body?.recur_dow ?? null,
        recur_dom: body?.recur_dom ?? null,
        interval_minutes: body?.interval_minutes ?? null,
        window_start: body?.window_start ?? null,
        window_end: body?.window_end ?? null,
        tz_offset_min: body?.tz_offset_min ?? 0,
        status: requestedStatus,
        next_run_at: next.next_run_at,
        assign_map: assignMapJson
      })

      replaceScheduleMessages(id, messages.messages)
    })

    log.info({ id, name, admin: req.admin!.username }, 'Programación editada.')
    return { ok: true, next_run_at: next.next_run_at }
  })

  app.delete<{ Params: { id: string } }>('/schedules/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const oldMessages = listScheduleMessages(id)
    const ok = deleteSchedule(id, req.admin!.id)
    if (!ok) return reply.code(404).send({ error: 'Programación no encontrada.' })
    for (const m of oldMessages) {
      deleteMediaIfOrphan(m.media_id)
    }
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/schedules/:id/pause', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const existing = getSchedule(id, req.admin!.id)
    if (!existing) return reply.code(404).send({ error: 'Programación no encontrada.' })

    setScheduleStatus(id, req.admin!.id, 'paused', null)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/schedules/:id/resume', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const existing = getSchedule(id, req.admin!.id)
    if (!existing) return reply.code(404).send({ error: 'Programación no encontrada.' })
    if (existing.sched_type === 'once' && existing.last_run_at) {
      return reply.code(409).send({ error: 'Esta programación ya se ejecutó. Creá una nueva o editala.' })
    }

    let nextRunAt: number | null
    if (existing.sched_type === 'once') {
      nextRunAt = existing.scheduled_at
    } else {
      nextRunAt = computeNextRun(
        existing.sched_type,
        parseTimes(existing.recur_times, existing.recur_time),
        existing.recur_dow,
        existing.recur_dom,
        existing.tz_offset_min,
        Date.now(),
        existing.interval_minutes,
        existing.window_start,
        existing.window_end
      )
    }

    setScheduleStatus(id, req.admin!.id, 'active', nextRunAt)
    return { ok: true, next_run_at: nextRunAt }
  })

  app.post<{ Params: { id: string } }>('/schedules/:id/run', async (req, reply) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    try {
      const results = await runScheduleNow(id, req.admin!.id)
      return {
        ok: true,
        sent: results.reduce((acc, r) => acc + r.sent, 0),
        failed: results.reduce((acc, r) => acc + r.failed, 0)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg, id: req.params.id }, 'POST /schedules/:id/run')
      return reply.code(500).send({ error: 'No se pudo ejecutar la programación.' })
    }
  })
}
