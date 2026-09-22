/**
 * Rate limiter para endpoints autenticados.
 *
 * Complementa el rate limiter de login (lib/adminAuth.ts) con un control
 * por admin_id para acciones autenticadas: publicar, subir multimedia,
 * crear/editar programaciones, etc.
 *
 * Implementacion en memoria (NodeCache). En despliegues con multiples
 * instancias o restarts frecuentes, considerar migrar a SQLite o Redis.
 *
 * Limites:
 *  - 30 acciones / minuto / admin  (publish, media upload, schedule create)
 *  - 10 publicaciones / minuto / admin (mas estricto para broadcast)
 *
 * En tests automatizados (RATE_LIMIT_DISABLED=1) se desactiva para no
 * interferir con la suite de 170+ pruebas que hace muchos publish seguidos.
 */

import NodeCache from 'node-cache'

const WINDOW_MS = 60_000 // 1 minuto

// Map: adminId -> { n, resetAt }
const actionCounts = new NodeCache({ stdTTL: 60, useClones: false })
const publishCounts = new NodeCache({ stdTTL: 60, useClones: false })

const MAX_ACTIONS_PER_MIN = 30
const MAX_PUBLISH_PER_MIN = 10

const DISABLED = process.env.RATE_LIMIT_DISABLED === '1'

interface CountEntry {
  n: number
  resetAt: number
}

function bump(cache: NodeCache, key: string, max: number): { ok: boolean; remaining: number; retryInSec: number } {
  if (DISABLED) return { ok: true, remaining: max, retryInSec: 0 }
  const now = Date.now()
  const entry = cache.get<CountEntry>(key) ?? { n: 0, resetAt: now + WINDOW_MS }
  if (now > entry.resetAt) {
    entry.n = 0
    entry.resetAt = now + WINDOW_MS
  }
  entry.n += 1
  cache.set(key, entry, Math.ceil((entry.resetAt - now) / 1000))
  return {
    ok: entry.n <= max,
    remaining: Math.max(0, max - entry.n),
    retryInSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  }
}

/**
 * Rate limit generico para acciones autenticadas (publish, schedule, media, etc.).
 * 30 acciones / minuto / admin.
 */
export function rateLimitAction(adminId: number): { ok: boolean; remaining: number; retryInSec: number } {
  return bump(actionCounts, `act:${adminId}`, MAX_ACTIONS_PER_MIN)
}

/**
 * Rate limit estricto para publicaciones (broadcast a grupos/canales).
 * 10 publicaciones / minuto / admin — frena floods que podrian banear cuentas WhatsApp.
 */
export function rateLimitPublish(adminId: number): { ok: boolean; remaining: number; retryInSec: number } {
  return bump(publishCounts, `pub:${adminId}`, MAX_PUBLISH_PER_MIN)
}

/** Helper: aplicarlo en una ruta Fastify. Devuelve true si paso, false si ya mando 429. */
export function enforceRateLimit(
  adminId: number,
  reply: { code: (c: number) => { send: (b: unknown) => void }; header: (k: string, v: string) => void },
  mode: 'action' | 'publish' = 'action'
): boolean {
  const rl = mode === 'publish' ? rateLimitPublish(adminId) : rateLimitAction(adminId)
  if (!rl.ok) {
    reply.header('Retry-After', String(rl.retryInSec))
    reply.code(429).send({ error: `Demasiadas acciones. Reintentar en ${rl.retryInSec}s.` })
    return false
  }
  return true
}
