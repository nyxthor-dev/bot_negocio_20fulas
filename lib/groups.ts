/**
 * Módulo de gestión de GRUPOS (@g.us).
 *
 * Maneja todas las operaciones relacionadas con grupos de WhatsApp:
 *   - Obtener todos los grupos donde participa el bot
 *   - Detectar grupos donde el bot es admin
 *   - Sincronizar grupos con la cache SQL
 *   - Resolver JIDs (LID ↔ PN) para matching correcto
 *
 * WhatsApp introdujo LID (Linked Identity) como sistema nuevo de privacidad.
 * Los participantes de grupos pueden aparecer con JID tipo `@lid` en lugar del
 * número de teléfono `@s.whatsapp.net`. Por eso el matching tiene que comparar
 * múltiples variantes del JID del bot.
 */

import type { GroupMetadata, WASocket } from '@fer2809fl/baileys'
import { upsertGroup } from './db.ts'
import { logger } from './logger.ts'

const log = logger('groups')

/**
 * Normaliza un JID eliminando el device ID (la parte `:N` antes del `@`).
 *
 * Ejemplos:
 *   "5356795360:13@s.whatsapp.net"  ->  "5356795360@s.whatsapp.net"
 *   "5356795360@s.whatsapp.net"     ->  "5356795360@s.whatsapp.net"
 *   "120363xxx@g.us"                ->  "120363xxx@g.us"
 */
export function normalizeJid(jid: string | undefined | null): string | null {
  if (!jid || typeof jid !== 'string') return null
  const atIdx = jid.indexOf('@')
  if (atIdx < 0) return jid
  const localPart = jid.slice(0, atIdx)
  const domain = jid.slice(atIdx)
  const colonIdx = localPart.indexOf(':')
  const cleanLocal = colonIdx >= 0 ? localPart.slice(0, colonIdx) : localPart
  return `${cleanLocal}${domain}`
}

/**
 * Obtiene TODAS las variantes posibles del JID del bot para matching.
 *
 * El bot tiene múltiples identificadores:
 *   - user.id:          "5356795360:13@s.whatsapp.net" (con device ID)
 *   - user.phoneNumber:  "5356795360@s.whatsapp.net"    (PN = Phone Number)
 *   - user.lid:          "242305378299948:13@lid"        (LID = Linked Identity)
 *
 * En los grupos, los participantes pueden aparecer con cualquiera de estas
 * variantes como `id`. Por eso necesitamos comparar contra todas.
 */
export function getBotJidVariants(sock: WASocket): string[] {
  const user = sock.user
  if (!user) return []

  const variants = new Set<string>()

  if (user.id) {
    variants.add(user.id)
    const norm = normalizeJid(user.id)
    if (norm) variants.add(norm)
  }
  if (user.phoneNumber) {
    variants.add(user.phoneNumber)
    const norm = normalizeJid(user.phoneNumber)
    if (norm) variants.add(norm)
  }
  if (user.lid) {
    variants.add(user.lid)
    const norm = normalizeJid(user.lid)
    if (norm) variants.add(norm)
  }

  return Array.from(variants)
}

/**
 * Obtiene la metadata completa de todos los grupos donde el bot participa.
 * Llama a la API de baileys `groupFetchAllParticipating`.
 *
 * IMPORTANTE: Esto sólo devuelve GRUPOS (@g.us), no canales (@newsletter).
 * Para canales, usar el módulo `newsletters.ts`.
 */
export async function fetchAllGroups(sock: WASocket): Promise<GroupMetadata[]> {
  const result = await sock.groupFetchAllParticipating()
  return Object.values(result)
}

/**
 * Devuelve true si el bot es admin en el grupo dado.
 *
 * IMPLEMENTACIÓN ROBUSTA: usa el método nativo `sock.isGroupAdmin()` de baileys
 * que maneja correctamente LID ↔ PN via signalRepository.
 *
 * Si el método nativo no está disponible, hace fallback a matching manual
 * comparando TODAS las variantes del bot (id, phoneNumber, lid) contra
 * TODAS las variantes de cada participante (id, lid, phoneNumber).
 */
export async function isBotAdminOfGroup(
  sock: WASocket,
  group: GroupMetadata
): Promise<boolean> {
  const myJids = getBotJidVariants(sock)
  if (myJids.length === 0) return false

  // Método preferido: API nativa de baileys (resuelve LID↔PN via signalRepository)
  // Cast: el tipo WASocket no declara isGroupAdmin en algunas versiones de baileys,
  // pero el método sí existe en runtime.
  const sockWithAdmin = sock as WASocket & {
    isGroupAdmin?: (jid: string, participantJid: string) => Promise<boolean>
  }
  if (typeof sockWithAdmin.isGroupAdmin === 'function') {
    // Probamos con cada variante del JID del bot (id, phoneNumber, lid)
    for (const myJid of myJids) {
      try {
        const result = await sockWithAdmin.isGroupAdmin(group.id, myJid)
        if (result) return true
      } catch {
        // continuar con siguiente variante
      }
    }
  }

  // Fallback: matching manual comparando todas las variantes
  const myJidVariants = new Set(myJids)

  const me = group.participants?.find(p => {
    const candidates = [
      normalizeJid(p.id),
      p.lid ? normalizeJid(p.lid) : null,
      p.phoneNumber ? normalizeJid(p.phoneNumber) : null
    ].filter((v): v is string => v !== null)
    return candidates.some(c => myJidVariants.has(c))
  })

  if (!me) return false

  return me.admin === 'admin'
    || me.admin === 'superadmin'
    || me.isAdmin === true
    || me.isSuperAdmin === true
}

/**
 * Devuelve true si el bot es superadmin (owner) del grupo.
 */
export async function isBotOwnerOfGroup(
  sock: WASocket,
  group: GroupMetadata
): Promise<boolean> {
  const myJids = getBotJidVariants(sock)
  const myJidVariants = new Set(myJids)

  return (group.participants ?? []).some(p => {
    const candidates = [
      normalizeJid(p.id),
      p.lid ? normalizeJid(p.lid) : null,
      p.phoneNumber ? normalizeJid(p.phoneNumber) : null
    ].filter((v): v is string => v !== null)
    return candidates.some(c => myJidVariants.has(c)) && p.admin === 'superadmin'
  })
}

export interface SyncGroupsResult {
  totalGroups: number
  adminGroups: number
  ownerGroups: number
  adminGroupsList: GroupMetadata[]
}

/**
 * Sincroniza todos los grupos donde participa la cuenta con la cache SQL.
 *
 * @param sock              Socket activo de baileys
 * @param cacheToDb         Si true, persiste el resultado en SQLite
 * @param accountId         Cuenta dueña de esta cache (los grupos son por cuenta)
 * @returns                 Resultado con totales y lista de grupos admin
 */
export async function syncGroups(
  sock: WASocket,
  cacheToDb: boolean = true,
  accountId: number = 0
): Promise<SyncGroupsResult> {
  const all = await fetchAllGroups(sock)
  const myJids = getBotJidVariants(sock)
  log.info(`Grupos: ${all.length} donde participa el bot. Bot JIDs: ${myJids.join(' | ')}`)

  const adminGroups: GroupMetadata[] = []
  let ownerGroups = 0
  const now = Date.now()

  for (const g of all) {
    try {
      const isAdmin = await isBotAdminOfGroup(sock, g)
      const isOwner = await isBotOwnerOfGroup(sock, g)
      // announce=true => sólo los admins del grupo pueden escribir.
      // Si somos admin podemos siempre; si somos miembros depende del announce.
      const canSend = isAdmin || g.announce !== true ? 1 : 0

      if (cacheToDb) {
        upsertGroup({
          account_id: accountId,
          jid: g.id,
          name: g.subject ?? '',
          is_admin: isAdmin ? 1 : 0,
          is_owner: isOwner ? 1 : 0,
          can_send: canSend,
          last_seen: now
        })
      }

      if (isAdmin) adminGroups.push(g)
      if (isOwner) ownerGroups++
    } catch (err) {
      log.warn({ err, jid: g.id }, 'Error procesando grupo individual — se omite.')
    }
  }

  log.info(`Grupos: ${adminGroups.length}/${all.length} donde soy admin, ${ownerGroups} donde soy owner.`)

  if (adminGroups.length === 0 && all.length > 0) {
    const firstGroup = all[0]
    const sampleParticipants = (firstGroup.participants ?? []).slice(0, 5).map(p => ({
      id: p.id,
      lid: p.lid,
      phoneNumber: p.phoneNumber,
      admin: p.admin
    }))
    log.warn({
      groupJid: firstGroup.id,
      groupName: firstGroup.subject,
      myJids,
      sampleParticipants
    }, 'Grupos: no se detectó admin en NINGÚN grupo. Mostrando primeros 5 participantes del primer grupo para diagnóstico.')
  }

  return {
    totalGroups: all.length,
    adminGroups: adminGroups.length,
    ownerGroups,
    adminGroupsList: adminGroups
  }
}
