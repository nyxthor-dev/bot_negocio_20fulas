/**
 * Rutas API para gestión de CANALES (@newsletter) por cuenta.
 *
 *   GET  /api/newsletters?account_id=N     -> lista canales admin de esa cuenta (cache SQL)
 *   POST /api/newsletters/refresh          -> sincroniza canales de una cuenta { account_id }
 */

import type { FastifyInstance } from 'fastify'
import { getAdminGroups, getAccount } from '../../lib/db.ts'
import { syncNewsletters } from '../../lib/client.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:newsletters')

function resolveOwnedAccount(adminId: number, bodyOrQuery: { account_id?: number | string } | undefined): number | null {
  const raw = bodyOrQuery?.account_id
  const accountId = Number(raw)
  if (!Number.isInteger(accountId)) return null
  const account = getAccount(accountId)
  if (!account || account.admin_id !== adminId) return null
  return accountId
}

export async function registerNewslettersRoutes(app: FastifyInstance): Promise<void> {
  // GET /newsletters -> lista cacheada de canales admin de una cuenta
  app.get('/newsletters', async (req, reply) => {
    try {
      const accountId = resolveOwnedAccount(req.admin!.id, req.query as { account_id?: string })
      if (!accountId) {
        return reply.code(400).send({ error: 'Falta account_id o la cuenta no es tuya.' })
      }

      const cached = getAdminGroups(accountId).filter(g => g.jid.endsWith('@newsletter'))
      return {
        account_id: accountId,
        count: cached.length,
        newsletters: cached.map(c => ({
          jid: c.jid,
          name: c.name,
          is_admin: c.is_admin === 1,
          is_owner: c.is_owner === 1,
          last_seen: c.last_seen
        }))
      }
    } catch (err) {
      log.error({ err }, 'GET /newsletters')
      return reply.code(500).send({ error: 'Error listando canales.' })
    }
  })

  // POST /newsletters/refresh -> sincroniza canales de una cuenta con WhatsApp
  app.post('/newsletters/refresh', async (req, reply) => {
    try {
      const body = req.body as { account_id?: number } | undefined
      const accountId = resolveOwnedAccount(req.admin!.id, body)
      if (!accountId) {
        return reply.code(400).send({ error: 'Falta account_id o la cuenta no es tuya.' })
      }

      log.info(`Sincronizando canales de la cuenta ${accountId}...`)
      const result = await syncNewsletters(accountId, true)
      log.info(`Sincronización de canales de cuenta ${accountId}: ${result.adminCount}/${result.total} admin`)

      const cached = getAdminGroups(accountId).filter(g => g.jid.endsWith('@newsletter'))
      return {
        account_id: accountId,
        total: result.total,
        admin_count: result.adminCount,
        count: cached.length,
        newsletters: cached.map(c => ({
          jid: c.jid,
          name: c.name,
          is_admin: c.is_admin === 1,
          is_owner: c.is_owner === 1,
          last_seen: c.last_seen
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'POST /newsletters/refresh')
      return reply.code(500).send({ error: 'Error sincronizando canales (¿está conectada la cuenta?).', details: msg })
    }
  })
}
