/**
 * Módulo de gestión de CANALES (@newsletter).
 *
 * Maneja todas las operaciones relacionadas con canales de WhatsApp:
 *   - Obtener todos los canales suscritos
 *   - Detectar canales donde el bot es admin/owner
 *   - Sincronizar canales con la cache SQL
 *
 * WhatsApp Channels (newsletters) usan JID tipo `@newsletter` y tienen su propia
 * API en baileys (separada de la de grupos).
 *
 * El shape devuelto por `newsletterFetchAllSubscribe` varía entre versiones
 * de baileys. Manejamos múltiples ubicaciones posibles para name y role.
 */

import type { WASocket } from '@fer2809fl/baileys'
import { upsertGroup } from './db.ts'
import { logger } from './logger.ts'

const log = logger('newsletters')

export interface ChannelInfo {
  jid: string
  name: string
  role: 'ADMIN' | 'OWNER' | 'SUBSCRIBER' | 'GUEST' | 'UNKNOWN'
  isAdmin: boolean
  isOwner: boolean
}

/**
 * Coerce a string seguro para SQLite (rechaza undefined/objetos/buffers).
 * Esto previene el error "SQLite3 can only bind numbers, strings, bigints..."
 */
export function safeStr(v: unknown, fallback: string = ''): string {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  // Objetos/arrays: no los guardamos como string JSON
  return fallback
}

/**
 * Obtiene todos los canales (newsletters) a los que el bot está suscrito.
 * Usa `newsletterFetchAllSubscribe` de baileys.
 *
 * El shape devuelto varía entre versiones de baileys. Posibles formas:
 *   - Array directo
 *   - Objeto con keys (se convierte a array)
 *   - El objeto NewsletterMetadata con propiedades anidadas
 */
export async function fetchSubscribedNewsletters(sock: WASocket): Promise<unknown[]> {
  const fn = (sock as unknown as {
    newsletterFetchAllSubscribe?: () => Promise<unknown>
  }).newsletterFetchAllSubscribe

  if (!fn) {
    log.warn('El socket no expone newsletterFetchAllSubscribe. ¿Versión de baileys sin soporte de canales?')
    return []
  }

  try {
    const result = await fn.call(sock)
    if (Array.isArray(result)) return result
    if (result && typeof result === 'object') {
      return Object.values(result as Record<string, unknown>)
    }
    return []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ err: msg }, 'newsletterFetchAllSubscribe falló — probablemente no hay canales suscritos.')
    return []
  }
}

/**
 * Extrae información normalizada de un canal, sin importar el shape exacto.
 *
 * Estructuras conocidas del objeto devuelto:
 *   { id, name, viewer_metadata: { role } }
 *   { id, state, thread_metadata: { name, creation_time }, viewer_metadata: { role } }
 *   { id, thread_metadata: { name: { text: "..." } } }   // nombre multi-idioma
 */
export function extractChannelInfo(raw: Record<string, unknown>): ChannelInfo {
  const jid = safeStr(raw?.id, '')

  // El nombre puede venir en varias ubicaciones
  const threadMeta = raw?.thread_metadata as Record<string, unknown> | undefined
  const nameFromThread = threadMeta?.name
  const name = safeStr(raw?.name)
    || safeStr(nameFromThread)
    || safeStr((nameFromThread as { text?: unknown })?.text)
    || safeStr((raw?.newsletterMetadata as { name?: unknown })?.name)
    || '(canal sin nombre)'

  // El role puede venir en viewer_metadata.role o directo como role
  const viewerMeta = raw?.viewer_metadata as Record<string, unknown> | undefined
  const roleRaw = viewerMeta?.role ?? raw?.role
  const roleStr = safeStr(roleRaw).toUpperCase() as ChannelInfo['role']

  const role: ChannelInfo['role'] =
    roleStr === 'ADMIN' ? 'ADMIN' :
    roleStr === 'OWNER' ? 'OWNER' :
    roleStr === 'SUBSCRIBER' ? 'SUBSCRIBER' :
    roleStr === 'GUEST' ? 'GUEST' :
    'UNKNOWN'

  return {
    jid,
    name,
    role,
    isAdmin: role === 'ADMIN' || role === 'OWNER',
    isOwner: role === 'OWNER'
  }
}

export interface SyncNewslettersResult {
  total: number
  adminCount: number
  adminList: ChannelInfo[]
}

/**
 * Sincroniza todos los canales suscritos de la cuenta con la cache SQL.
 *
 * @param sock              Socket activo
 * @param cacheToDb         Si true, persiste en SQLite
 * @param accountId         Cuenta dueña de esta cache (los canales son por cuenta)
 */
export async function syncNewsletters(
  sock: WASocket,
  cacheToDb: boolean = true,
  accountId: number = 0
): Promise<SyncNewslettersResult> {
  const rawList = await fetchSubscribedNewsletters(sock)
  const channels: ChannelInfo[] = []
  const now = Date.now()

  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i] as Record<string, unknown>
    try {
      const info = extractChannelInfo(raw)
      if (!info.jid) {
        if (i === 0) {
          log.warn({ shape: JSON.stringify(raw).slice(0, 500) }, 'Primer canal sin id — shape para debug.')
        }
        continue
      }

      if (cacheToDb) {
        upsertGroup({
          account_id: accountId,
          jid: info.jid,
          name: info.name,
          is_admin: info.isAdmin ? 1 : 0,
          is_owner: info.isOwner ? 1 : 0,
          can_send: info.isAdmin ? 1 : 0,
          last_seen: now
        })
      }

      channels.push(info)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ err: msg, idx: i, raw: JSON.stringify(raw).slice(0, 300) }, 'Error procesando canal — se omite.')
    }
  }

  const adminList = channels.filter(c => c.isAdmin)
  log.info(`Canales: ${adminList.length}/${channels.length} donde soy admin.`)

  return {
    total: channels.length,
    adminCount: adminList.length,
    adminList
  }
}

/**
 * Devuelve la lista de canales donde el bot es admin (fetch en vivo).
 */
export async function fetchAdminNewsletters(sock: WASocket): Promise<ChannelInfo[]> {
  const result = await syncNewsletters(sock, false)
  return result.adminList
}
