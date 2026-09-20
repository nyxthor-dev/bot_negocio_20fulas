/**
 * Rutas API para gestión de GRUPOS (@g.us) por cuenta.
 *
 *   GET  /api/groups?account_id=N[&scope=all|admin] -> grupos de esa cuenta (cache SQL)
 *   POST /api/groups/refresh               -> sincroniza grupos de una cuenta { account_id }
 *   GET  /api/groups/all?account_id=N      -> TODOS los grupos en vivo (sin tocar SQL)
 *
 * scope=all devuelve también los grupos donde la cuenta es sólo miembro:
 * se puede publicar en ellos si el grupo permite escribir a los miembros.
 * can_send=false marca los grupos donde sólo escriben los admins (y la
 * cuenta no lo es): el envío fallará y queda registrado con su error real.
 */

import type { FastifyInstance } from 'fastify'
import { getAdminGroups, getAllCachedGroups, getAccount, countAdminGroups } from '../../lib/db.ts'
import { syncGroups, getAccountSocket } from '../../lib/client.ts'
import { fetchAllGroups as fetchAllGroupsFor, isBotAdminOfGroup } from '../../lib/groups.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:groups')

function resolveOwnedAccount(adminId: number, bodyOrQuery: { account_id?: number | string } | undefined): number | null {
  const raw = bodyOrQuery?.account_id
  const accountId = Number(raw)
  if (!Number.isInteger(accountId)) return null
  const account = getAccount(accountId)
  if (!account || account.admin_id !== adminId) return null
  return accountId
}

export async function registerGroupsRoutes(app: FastifyInstance): Promise<void> {
  // GET /groups -> lista cacheada de grupos de una cuenta (sólo @g.us)
  app.get('/groups', async (req, reply) => {
    try {
      const query = req.query as { account_id?: string; scope?: string }
      const accountId = resolveOwnedAccount(req.admin!.id, query)
      if (!accountId) {
        return reply.code(400).send({ error: 'Falta account_id o la cuenta no es tuya.' })
      }

      const onlyAdmin = query.scope === 'admin'
      const cached = (onlyAdmin ? getAdminGroups(accountId) : getAllCachedGroups(accountId))
        .filter(g => g.jid.endsWith('@g.us'))
      return {
        account_id: accountId,
        count: cached.length,
        admin_count: cached.filter(g => g.is_admin === 1).length,
        groups: cached.map(g => ({
          jid: g.jid,
          name: g.name,
          is_admin: g.is_admin === 1,
          is_owner: g.is_owner === 1,
          can_send: g.can_send === 1,
          last_seen: g.last_seen
        }))
      }
    } catch (err) {
      log.error({ err }, 'GET /groups')
      return reply.code(500).send({ error: 'Error listando grupos.' })
    }
  })

  // POST /groups/refresh -> sincroniza una cuenta con WhatsApp y devuelve lista nueva
  app.post('/groups/refresh', async (req, reply) => {
    try {
      const body = req.body as { account_id?: number } | undefined
      const accountId = resolveOwnedAccount(req.admin!.id, body)
      if (!accountId) {
        return reply.code(400).send({ error: 'Falta account_id o la cuenta no es tuya.' })
      }

      log.info(`Sincronizando grupos de la cuenta ${accountId}...`)
      const result = await syncGroups(accountId, true)
      log.info(`Sincronización de cuenta ${accountId}: ${result.adminGroups}/${result.totalGroups} admin`)

      const cached = getAllCachedGroups(accountId).filter(g => g.jid.endsWith('@g.us'))
      return {
        account_id: accountId,
        total: result.totalGroups,
        admin_count: result.adminGroups,
        owner_count: result.ownerGroups,
        count: cached.length,
        groups: cached.map(g => ({
          jid: g.jid,
          name: g.name,
          is_admin: g.is_admin === 1,
          is_owner: g.is_owner === 1,
          can_send: g.can_send === 1,
          last_seen: g.last_seen
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'POST /groups/refresh')
      return reply.code(500).send({ error: 'Error sincronizando grupos (¿está conectada la cuenta?).', details: msg })
    }
  })

  // GET /groups/all -> TODOS los grupos donde participa la cuenta (no sólo admin)
  app.get('/groups/all', async (req, reply) => {
    try {
      const accountId = resolveOwnedAccount(req.admin!.id, req.query as { account_id?: string })
      if (!accountId) {
        return reply.code(400).send({ error: 'Falta account_id o la cuenta no es tuya.' })
      }

      const sock = getAccountSocket(accountId)
      const all = await fetchAllGroupsFor(sock)
      const groups = await Promise.all(all.map(async g => {
        const isAdmin = await isBotAdminOfGroup(sock, g)
        return {
          jid: g.id,
          name: g.subject ?? '',
          is_admin: isAdmin,
          can_send: isAdmin || g.announce !== true,
          participants_count: g.participants?.length ?? 0
        }
      }))
      return {
        account_id: accountId,
        count: groups.length,
        groups
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'GET /groups/all')
      return reply.code(500).send({ error: 'Error listando todos los grupos.', details: msg })
    }
  })
}
