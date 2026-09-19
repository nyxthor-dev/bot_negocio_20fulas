/**
 * Rutas API para gestión de GRUPOS (@g.us).
 *
 *   GET  /api/groups              -> lista TODOS los grupos del cache SQL (admin y no admin)
 *   POST /api/groups/refresh      -> fuerza sincronización con WhatsApp
 *   GET  /api/groups/all          -> alias de /api/groups (compat)
 *   GET  /api/groups/live         -> lista en vivo desde WhatsApp (más lento, sólo diagnóstico)
 */

import type { FastifyInstance } from 'fastify'
import {
  fetchAllGroups,
  isBotAdminOfGroup,
  syncGroups
} from '../../lib/client.ts'
import { getAllCachedGroups } from '../../lib/db.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:groups')

export async function registerGroupsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/groups -> devuelve TODOS los grupos del cache SQL (donde el bot es miembro).
  // Cada grupo incluye el flag is_admin para que el frontend pueda mostrarlos
  // con badges visuales y permitir al usuario elegir a cuáles publicar.
  app.get('/groups', async (_req, reply) => {
    try {
      const all = getAllCachedGroups().filter(g => g.jid.endsWith('@g.us'))
      const adminCount = all.filter(g => g.is_admin === 1).length
      return {
        count: all.length,
        admin_count: adminCount,
        groups: all.map(g => ({
          jid: g.jid,
          name: g.name,
          is_admin: g.is_admin === 1,
          is_owner: g.is_owner === 1,
          last_seen: g.last_seen
        }))
      }
    } catch (err) {
      log.error({ err }, 'GET /groups')
      return reply.code(500).send({ error: 'Error listando grupos.' })
    }
  })

  // POST /api/groups/refresh -> sincroniza con WhatsApp y devuelve lista nueva (todos los grupos)
  app.post('/groups/refresh', async (_req, reply) => {
    try {
      log.info('Sincronizando grupos con WhatsApp...')
      const result = await syncGroups(true)
      log.info(`Sincronización de grupos completada: ${result.adminGroups}/${result.totalGroups} admin`)

      const cached = getAllCachedGroups().filter(g => g.jid.endsWith('@g.us'))
      return {
        total: result.totalGroups,
        admin_count: result.adminGroups,
        owner_count: result.ownerGroups,
        count: cached.length,
        groups: cached.map(g => ({
          jid: g.jid,
          name: g.name,
          is_admin: g.is_admin === 1,
          is_owner: g.is_owner === 1,
          last_seen: g.last_seen
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'POST /groups/refresh')
      return reply.code(500).send({
        error: 'Error sincronizando grupos.',
        details: msg
      })
    }
  })

  // GET /api/groups/all -> alias de /api/groups (compat con versiones anteriores)
  app.get('/groups/all', async (_req, reply) => {
    try {
      const all = getAllCachedGroups().filter(g => g.jid.endsWith('@g.us'))
      return {
        count: all.length,
        admin_count: all.filter(g => g.is_admin === 1).length,
        groups: all.map(g => ({
          jid: g.jid,
          name: g.name,
          is_admin: g.is_admin === 1,
          is_owner: g.is_owner === 1,
          last_seen: g.last_seen
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'GET /groups/all')
      return reply.code(500).send({
        error: 'Error listando todos los grupos.',
        details: msg
      })
    }
  })

  // GET /api/groups/live -> lista en vivo desde WhatsApp (más lento)
  app.get('/groups/live', async (_req, reply) => {
    try {
      const all = await fetchAllGroups()
      const groups = await Promise.all(all.map(async g => ({
        jid: g.id,
        name: g.subject ?? '',
        is_admin: await isBotAdminOfGroup(g),
        participants_count: g.participants?.length ?? 0
      })))
      return {
        count: groups.length,
        groups
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'GET /groups/live')
      return reply.code(500).send({
        error: 'Error listando grupos en vivo.',
        details: msg
      })
    }
  })
}
