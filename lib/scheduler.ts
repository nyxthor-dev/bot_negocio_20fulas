/**
 * Motor de programación de publicaciones.
 *
 * Cada programación tiene:
 *  - tipo: once (fecha puntual) | daily | weekly | monthly | interval
 *  - horarios: daily/weekly/monthly aceptan VARIOS horarios por día
 *    (recur_times, array de minutos 0-1439) para repetir la publicación
 *    varias veces al día; interval repite cada N minutos con ventana
 *    horaria opcional (sólo entre window_start y window_end).
 *  - mensajes: una o más filas { cuenta, destinos, texto, decoraciones, media }
 *
 * El tick corre cada 20 segundos, busca programaciones activas cuyo
 * next_run_at ya venció y las ejecuta. Las recurrentes avanzan a su
 * próximo vencimiento; las de "una vez" quedan en estado done.
 *
 * Los horarios recurrentes se interpretan en la zona horaria del admin
 * que creó la programación (el panel manda el offset en minutos).
 */

import {
  getDueSchedules,
  listScheduleMessages,
  markScheduleRun,
  getSchedule,
  getAccount,
  type ScheduleRow,
  type ScheduleType
} from './db.ts'
import { dedupeCrossAccount } from './dedupe.ts'
import { logger } from './logger.ts'

const log = logger('scheduler')

const TICK_INTERVAL_MS = 20_000

/** Máximo de horarios distintos por día (evita schedules absurdos). */
const MAX_TIMES_PER_DAY = 20

/**
 * Parsea el mapa de elección { jid → accountId } guardado en la programación.
 * Devuelve null si no hay mapa, está corrupto o no tiene entradas válidas.
 * La validación fina (que la cuenta asignada realmente tenga ese destino)
 * la hace dedupeCrossAccount con su fallback determinista.
 */
function parseAssignMap(
  raw: string | null | undefined,
  items: Array<{ accountId: number; jids: string[] }>
): Record<string, number> | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const participantIds = new Set(items.map(i => i.accountId))
  const out: Record<string, number> = {}
  for (const [jid, accId] of Object.entries(parsed as Record<string, unknown>)) {
    const num = Number(accId)
    if (typeof jid === 'string' && jid.length > 0 && jid.length <= 200 && Number.isInteger(num) && participantIds.has(num)) {
      out[jid] = num
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

export interface BroadcastResult {
  sent: number
  failed: number
}

/**
 * Firma de la función que envía un mensaje por una cuenta y lo registra.
 * El scheduler real la conecta con el broadcast de baileys; los tests
 * inyectan una versión mock.
 */
export type ScheduleSendFn = (
  accountId: number,
  jids: string[],
  text: string,
  decorations: { forwarded?: boolean; parseMarkdown?: boolean } | null,
  adminId: number,
  scheduleId: number | null,
  mediaId: number | null
) => Promise<BroadcastResult>

let tickTimer: NodeJS.Timeout | null = null
let sendFn: ScheduleSendFn | null = null
const runningScheduleIds = new Set<number>()

/** Arranca el loop. sendFn es inyectable para poder testear sin WhatsApp. */
export function startScheduler(send: ScheduleSendFn): void {
  sendFn = send
  if (tickTimer) return
  tickTimer = setInterval(() => {
    void runDueSchedules().catch(err => {
      log.error({ err }, 'Error en el tick del scheduler.')
    })
  }, TICK_INTERVAL_MS)
  log.info(`Scheduler activo (tick cada ${TICK_INTERVAL_MS / 1000}s).`)
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
    log.info('Scheduler detenido.')
  }
}

/** ¿Está el scheduler corriendo? (para tests y diagnóstico) */
export function isSchedulerRunning(): boolean {
  return tickTimer !== null
}

/* ---------- Cálculo de próximos vencimientos ---------- */

/**
 * Epoch ms "ahora" expresado en la zona horaria del admin.
 * JS getTimezoneOffset() devuelve minutos a SUMAR a la hora local para obtener
 * UTC (ej: Cuba UTC-4 → 240). Local = UTC - offset.
 */
function localMs(utcMs: number, tzOffsetMin: number): number {
  return utcMs - tzOffsetMin * 60_000
}

function fromLocalMs(lMs: number, tzOffsetMin: number): number {
  return lMs + tzOffsetMin * 60_000
}

function localParts(lMs: number): { y: number; m: number; d: number; h: number; min: number; dow: number; dom: number } {
  const d = new Date(lMs)
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    dow: d.getUTCDay(),
    dom: d.getUTCDate()
  }
}

/** Normaliza el array de horarios: deduplica, ordena y valida. */
export function parseTimes(timesJson: string | null | undefined, fallback: number | null | undefined): number[] {
  let times: number[] = []
  if (timesJson) {
    try {
      const parsed = JSON.parse(timesJson)
      if (Array.isArray(parsed)) times = parsed.map(Number)
    } catch { /* json corrupto: caemos al fallback */ }
  }
  if (times.length === 0 && fallback !== null && fallback !== undefined && Number.isFinite(fallback)) {
    times = [Number(fallback)]
  }
  return Array.from(new Set(times.filter(t => Number.isInteger(t) && t >= 0 && t <= 1439))).sort((a, b) => a - b)
}

/**
 * Calcula el próximo vencimiento de una programación a partir de un instante.
 * Devuelve epoch ms UTC, o null si no aplica.
 *
 *  - daily/weekly/monthly: el primer horario de recur_times que venga después
 *    de fromMs (hoy si queda alguno, si no el primero de mañana / próximo
 *    día de la semana / próximo día del mes).
 *  - interval: fromMs + N minutos, recortado a la ventana horaria si existe.
 */
export function computeNextRun(
  type: ScheduleType,
  recur_times: number[] | null | undefined,
  recur_dow: number | null | undefined,
  recur_dom: number | null | undefined,
  tzOffsetMin: number,
  fromMs: number = Date.now(),
  interval_minutes: number | null | undefined = null,
  window_start: number | null | undefined = null,
  window_end: number | null | undefined = null
): number | null {
  if (type === 'once') return null

  if (type === 'interval') {
    if (!interval_minutes || interval_minutes < 1) return null
    let next = fromMs + interval_minutes * 60_000
    if (window_start !== null && window_start !== undefined && window_end !== null && window_end !== undefined) {
      const p = localParts(localMs(next, tzOffsetMin))
      const minutesOfDay = p.h * 60 + p.min
      const startOfDayLocal = Date.UTC(p.y, p.m, p.d, 0, 0, 0, 0)
      if (minutesOfDay < window_start) {
        next = fromLocalMs(startOfDayLocal + window_start * 60_000, tzOffsetMin)
      } else if (minutesOfDay >= window_end) {
        next = fromLocalMs(startOfDayLocal + 86_400_000 + window_start * 60_000, tzOffsetMin)
      }
    }
    return next
  }

  const times = Array.isArray(recur_times) ? recur_times.filter(t => Number.isInteger(t) && t >= 0 && t <= 1439) : []
  if (times.length === 0) return null

  const lNow = localMs(fromMs, tzOffsetMin)
  const p = localParts(lNow)
  const startOfDayLocal = Date.UTC(p.y, p.m, p.d, 0, 0, 0, 0)
  const DAY = 86_400_000

  let best: number | null = null
  const consider = (candidateLocal: number) => {
    const candidateUtc = fromLocalMs(candidateLocal, tzOffsetMin)
    if (candidateUtc > fromMs && (best === null || candidateUtc < best)) {
      best = candidateUtc
    }
  }

  for (const t of times) {
    switch (type) {
      case 'daily': {
        consider(startOfDayLocal + t * 60_000)
        consider(startOfDayLocal + DAY + t * 60_000)
        break
      }
      case 'weekly': {
        if (recur_dow === null || recur_dow === undefined) break
        const delta = (recur_dow - p.dow + 7) % 7
        consider(startOfDayLocal + delta * DAY + t * 60_000)
        consider(startOfDayLocal + (delta + 7) * DAY + t * 60_000)
        break
      }
      case 'monthly': {
        if (recur_dom === null || recur_dom === undefined) break
        consider(Date.UTC(p.y, p.m, recur_dom, 0, 0, 0, 0) + t * 60_000)
        consider(Date.UTC(p.y, p.m + 1, recur_dom, 0, 0, 0, 0) + t * 60_000)
        break
      }
    }
  }

  return best
}

/**
 * Valida y calcula el next_run inicial al crear/editar una programación.
 * Devuelve epoch ms o null (con error descriptivo si algo no cierra).
 */
export function resolveNextRun(input: {
  sched_type: ScheduleType
  scheduled_at?: number | null
  recur_time?: number | null
  recur_times?: number[] | null
  recur_dow?: number | null
  recur_dom?: number | null
  interval_minutes?: number | null
  window_start?: number | null
  window_end?: number | null
  tz_offset_min?: number
  status?: 'active' | 'paused' | 'done'
}): { ok: boolean; error?: string; next_run_at: number | null; times?: number[] } {
  const tz = input.tz_offset_min ?? 0

  if (input.status === 'paused' || input.status === 'done') {
    return { ok: true, next_run_at: null }
  }

  if (input.sched_type === 'once') {
    if (!input.scheduled_at || !Number.isFinite(input.scheduled_at)) {
      return { ok: false, error: 'Falta la fecha y hora de la programación.', next_run_at: null }
    }
    if (input.scheduled_at <= Date.now() + 30_000) {
      return { ok: false, error: 'La fecha debe ser posterior a ahora (mínimo 30 segundos).', next_run_at: null }
    }
    return { ok: true, next_run_at: Math.floor(input.scheduled_at) }
  }

  if (input.sched_type === 'interval') {
    if (input.interval_minutes === null || input.interval_minutes === undefined || !Number.isInteger(input.interval_minutes) || input.interval_minutes < 1 || input.interval_minutes > 1440) {
      return { ok: false, error: 'El intervalo debe estar entre 1 y 1440 minutos.', next_run_at: null }
    }
    const hasStart = input.window_start !== null && input.window_start !== undefined
    const hasEnd = input.window_end !== null && input.window_end !== undefined
    if (hasStart !== hasEnd) {
      return { ok: false, error: 'La ventana horaria necesita inicio y fin.', next_run_at: null }
    }
    if (hasStart && hasEnd) {
      if (input.window_start! < 0 || input.window_start! > 1439 || input.window_end! < 1 || input.window_end! > 1440 || input.window_start! >= input.window_end!) {
        return { ok: false, error: 'Ventana horaria inválida (inicio antes que fin, en minutos 0-1440).', next_run_at: null }
      }
    }
    const next = computeNextRun(
      'interval', null, null, null, tz,
      Date.now(), input.interval_minutes,
      hasStart ? input.window_start! : null,
      hasEnd ? input.window_end! : null
    )
    return { ok: true, next_run_at: next }
  }

  // daily / weekly / monthly: uno o varios horarios por día
  const times = parseTimes(
    input.recur_times ? JSON.stringify(input.recur_times) : null,
    input.recur_time ?? null
  )
  if (times.length === 0) {
    return { ok: false, error: 'Falta al menos un horario.', next_run_at: null }
  }
  if (times.length > MAX_TIMES_PER_DAY) {
    return { ok: false, error: `Máximo ${MAX_TIMES_PER_DAY} horarios por día.`, next_run_at: null }
  }
  if (input.sched_type === 'weekly' && (input.recur_dow === null || input.recur_dow === undefined || input.recur_dow < 0 || input.recur_dow > 6)) {
    return { ok: false, error: 'Día de la semana inválido (0-6).', next_run_at: null }
  }
  if (input.sched_type === 'monthly' && (input.recur_dom === null || input.recur_dom === undefined || input.recur_dom < 1 || input.recur_dom > 28)) {
    return { ok: false, error: 'Día del mes inválido (1-28).', next_run_at: null }
  }

  const next = computeNextRun(input.sched_type, times, input.recur_dow, input.recur_dom, tz)
  return { ok: true, next_run_at: next, times }
}

/* ---------- Ejecución ---------- */

/**
 * Ejecuta todas las programaciones vencidas. Devuelve cuántas procesó.
 * Es safe llamarlo en paralelo: cada schedule se marca "en ejecución".
 */
export async function runDueSchedules(now: number = Date.now()): Promise<number> {
  if (!sendFn) return 0

  const due = getDueSchedules(now)
  let processed = 0

  for (const schedule of due) {
    if (runningScheduleIds.has(schedule.id)) continue
    runningScheduleIds.add(schedule.id)
    try {
      await executeSchedule(schedule, now)
      processed++
    } finally {
      runningScheduleIds.delete(schedule.id)
    }
  }

  return processed
}

/** Ejecuta una programación puntual (botón "ejecutar ahora" del panel). */
export async function runScheduleNow(scheduleId: number, adminId: number): Promise<BroadcastResult[]> {
  const schedule = getSchedule(scheduleId, adminId)
  if (!schedule) throw new Error('Programación no encontrada.')

  if (runningScheduleIds.has(schedule.id)) {
    throw new Error('La programación ya se está ejecutando.')
  }
  runningScheduleIds.add(schedule.id)
  try {
    return await executeSchedule(schedule, Date.now(), true)
  } finally {
    runningScheduleIds.delete(schedule.id)
  }
}

/**
 * Reasignación de seguridad para envíos programados (sin usuario presente).
 *
 * Si la cuenta que quedó dueña de un jid (por elección o por orden) está
 * DESCONECTADA al momento de ejecutar, y otra cuenta participante de la
 * programación que también tenía ese destino SÍ está conectada, el destino
 * viaja a esa cuenta: para una programación es mejor que el mensaje salga
 * por otra cuenta del mismo admin a que se pierda en silencio (todas las
 * demás des/conectadas dejan el fallo explícito en el historial).
 */
function reassignAwayFromDisconnected(
  items: Array<{ accountId: number; jids: string[] }>,
  originalMembership: Array<{ accountId: number; jids: string[] }>
): Array<{ fromAccountId: number; toAccountId: number; jid: string }> {
  const moved: Array<{ fromAccountId: number; toAccountId: number; jid: string }> = []

  // Estado de conexión por cuenta participante (una sola consulta por cuenta)
  const connected = new Map<number, boolean>()
  for (const item of items) {
    if (!connected.has(item.accountId)) {
      connected.set(item.accountId, getAccount(item.accountId)?.status === 'connected')
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (connected.get(item.accountId)) continue
    const keep: string[] = []
    for (const jid of item.jids) {
      // Otra cuenta participante que tenía este destino y está conectada
      const altIdx = originalMembership.findIndex((m, idx) =>
        idx !== i && m.jids.includes(jid) && connected.get(m.accountId) === true
      )
      if (altIdx >= 0) {
        items[altIdx].jids.push(jid)
        moved.push({ fromAccountId: item.accountId, toAccountId: items[altIdx].accountId, jid })
      } else {
        keep.push(jid) // sin alternativa conectada: falla explícita con su motivo
      }
    }
    item.jids = keep
  }

  return moved
}

async function executeSchedule(schedule: ScheduleRow, now: number, manual: boolean = false): Promise<BroadcastResult[]> {
  const messages = listScheduleMessages(schedule.id)
  const results: BroadcastResult[] = []

  log.info(`Ejecutando programación "${schedule.name}" (id ${schedule.id}): ${messages.length} mensaje(s).`)

  // Parseo previo de los destinos de cada mensaje
  const prepared = messages.map(msg => {
    let jids: string[] = []
    try {
      jids = JSON.parse(msg.target_jids) as string[]
    } catch {
      jids = []
    }
    return { msg, jids }
  })

  // Deduplicación entre cuentas: si dos mensajes de esta programación
  // (cada uno con su cuenta) apuntan al mismo grupo/canal, sólo lo envía
  // uno: la cuenta elegida por el usuario (assign_map persistido) o, si
  // no hay elección válida, la primera en el orden de los mensajes.
  const assign = parseAssignMap(schedule.assign_map, prepared.map(p => ({ accountId: p.msg.account_id, jids: p.jids })))
  const { items: deduped, skipped } = dedupeCrossAccount(prepared.map(p => ({ accountId: p.msg.account_id, jids: p.jids })), assign)
  if (skipped.length > 0) {
    log.warn({ scheduleId: schedule.id, skipped: skipped.map(s => ({ accountId: s.accountId, jid: s.jid, keptBy: s.keptByAccountId })) }, `Deduplicados ${skipped.length} destino(s) repetidos entre cuentas de la programación.`)
  }

  // La cuenta elegida puede haberse desconectado desde que se guardó la
  // programación: mover el destino a otra participante conectada si existe.
  const moved = reassignAwayFromDisconnected(deduped, prepared.map(p => ({ accountId: p.msg.account_id, jids: p.jids })))
  if (moved.length > 0) {
    log.warn({ scheduleId: schedule.id, moved }, `${moved.length} destino(s) reasignados a otra cuenta conectada (la elegida estaba desconectada).`)
  }

  for (let i = 0; i < prepared.length; i++) {
    const { msg } = prepared[i]
    const jids = deduped[i].jids
    let decorations: { forwarded?: boolean; parseMarkdown?: boolean } | null = null
    if (msg.decorations) {
      try { decorations = JSON.parse(msg.decorations) } catch { decorations = null }
    }

    // Todos los destinos de este mensaje ya los cubre otra cuenta
    if (jids.length === 0) {
      results.push({ sent: 0, failed: 0 })
      continue
    }

    try {
      const r = await sendFn!(msg.account_id, jids, msg.text, decorations, schedule.admin_id, schedule.id, msg.media_id ?? null)
      results.push(r)
    } catch (err) {
      const msgErr = err instanceof Error ? err.message : String(err)
      log.error({ err: msgErr, scheduleId: schedule.id, accountId: msg.account_id }, 'Fallo enviando mensaje programado.')
      results.push({ sent: 0, failed: jids.length })
    }
  }

  // Avance de estado: las de "una vez" terminan; las recurrentes agendan la
  // próxima. Guard de concurrencia: si la schedule fue EDITADA mientras el
  // envío estaba en curso, la edición ya dejó su propio next_run_at/status
  // y NO se pisan acá (antes una "once" editada a daily terminaba en done).
  const advanced = schedule.sched_type === 'once'
    ? markScheduleRun(schedule.id, now, null, true, schedule.updated_at)
    : (() => {
        // +60s para no re-ejecutar en el mismo minuto
        const times = parseTimes(schedule.recur_times, schedule.recur_time)
        const next = computeNextRun(
          schedule.sched_type,
          times,
          schedule.recur_dow,
          schedule.recur_dom,
          schedule.tz_offset_min,
          now + 60_000,
          schedule.interval_minutes,
          schedule.window_start,
          schedule.window_end
        )
        return markScheduleRun(schedule.id, now, next, false, schedule.updated_at)
      })()
  if (advanced) {
    log.info(`Programación "${schedule.name}" ejecutada. Próxima: ${schedule.sched_type === 'once' ? 'finalizada' : 'según horario'}.`)
  } else {
    log.warn(`Programación "${schedule.name}" (id ${schedule.id}) fue editada durante la ejecución: se conserva el estado de la edición.`)
  }

  return results
}
