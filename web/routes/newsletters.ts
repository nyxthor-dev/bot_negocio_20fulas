/**
 * Rutas API para gestión de CANALES (@newsletter).
 *
 *   GET  /api/newsletters              -> lista canales admin (desde cache SQL)
 *   POST /api/newsletters/refresh      -> fuerza sincronización con WhatsApp
 *   GET  /api/newsletters/all          -> lista TODOS los canales suscritos
 */

import type { FastifyInstance } from 'fastify'
import { syncNewsletters } from '../../lib/client.ts'
import { getAllCachedGroups } from '../../lib/db.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:newsletters')

export async function registerNewslettersRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/newsletters -> devuelve lista cacheada de canales admin
  app.get('/newsletters', async (_req, reply) => {
    try {
      const all = getAllCachedGroups()
      // Filtrar sólo canales @newsletter con is_admin=1
      const channels = all.filter(g => g.jid.endsWith('@newsletter') && g.is_admin === 1)
      return {
        count: channels.length,
        newsletters: channels.map(c => ({
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

  // POST /api/newsletters/refresh -> sincroniza canales con WhatsApp
  app.post('/newsletters/refresh', async (_req, reply) => {
    try {
      log.info('Iniciando sincronización de canales con WhatsApp...')
      const result = await syncNewsletters(true)
      log.info(`Sincronización de canales completada: ${result.adminCount}/${result.total} admin`)

      const cached = getAllCachedGroups().filter(g => g.jid.endsWith('@newsletter') && g.is_admin === 1)
      return {
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
      return reply.code(500).send({
        error: 'Error sincronizando canales.',
        details: msg
      })
    }
  })

  // GET /api/newsletters/all -> TODOS los canales del cache (admin y no admin)
  app.get('/newsletters/all', async (_req, reply) => {
    try {
      const all = getAllCachedGroups().filter(g => g.jid.endsWith('@newsletter'))
      return {
        count: all.length,
        admin_count: all.filter(g => g.is_admin === 1).length,
        newsletters: all.map(c => ({
          jid: c.jid,
          name: c.name,
          is_admin: c.is_admin === 1,
          is_owner: c.is_owner === 1,
          last_seen: c.last_seen
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'GET /newsletters/all')
      return reply.code(500).send({
        error: 'Error listando todos los canales.',
        details: msg
      })
    }
  })
}
