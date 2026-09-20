/**
 * Rutas de gestión de administradores (sólo superadmin).
 *
 *   GET    /api/admins                 -> lista todos los admins
 *   POST   /api/admins                 -> crea un admin { username, password, role }
 *   PUT    /api/admins/:id/password    -> resetea la contraseña (revoca sesiones)
 *   POST   /api/admins/:id/disable     -> deshabilita (revoca sesiones)
 *   POST   /api/admins/:id/enable      -> vuelve a habilitar
 *   DELETE /api/admins/:id             -> elimina (con sus cuentas/plantillas/programaciones)
 */

import type { FastifyInstance } from 'fastify'
import {
  createAdmin,
  resetAdminPassword,
  disableAdmin,
  enableAdmin,
  removeAdmin,
  listAdmins
} from '../../lib/adminAuth.ts'
import { requireSuperadmin } from '../auth.ts'
import { countAdminGroups, listAccounts, listSchedules } from '../../lib/db.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:admins')

export async function registerAdminsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admins', async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return

    const admins = listAdmins().map(a => {
      const accounts = listAccounts(a.id)
      return {
        id: a.id,
        username: a.username,
        role: a.role,
        disabled: a.disabled === 1,
        created_at: a.created_at,
        accounts_count: accounts.length,
        connected_accounts: accounts.filter(acc => acc.status === 'connected').length,
        admin_groups: accounts.reduce((sum, acc) => sum + countAdminGroups(acc.id), 0),
        schedules_count: listSchedules(a.id).filter(s => s.status === 'active').length
      }
    })
    return { count: admins.length, items: admins }
  })

  app.post('/admins', async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return

    const body = req.body as { username?: string; password?: string; role?: string } | undefined
    const username = String(body?.username ?? '').trim()
    const password = String(body?.password ?? '')
    const role = body?.role === 'superadmin' ? 'superadmin' : 'admin'

    const result = createAdmin(username, password, role)
    if (!result.ok) {
      return reply.code(400).send({ error: result.error })
    }
    return { id: result.id, username, role }
  })

  app.put<{ Params: { id: string } }>('/admins/:id/password', async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const admin = listAdmins().find(a => a.id === id)
    if (!admin) return reply.code(404).send({ error: 'Admin no encontrado.' })

    const body = req.body as { password?: string } | undefined
    const password = String(body?.password ?? '')

    const result = resetAdminPassword(admin.username, password)
    if (!result.ok) {
      return reply.code(400).send({ error: result.error })
    }
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/admins/:id/disable', async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    if (id === req.admin!.id) {
      return reply.code(400).send({ error: 'No podés deshabilitarte a vos mismo.' })
    }

    const admin = listAdmins().find(a => a.id === id)
    if (!admin) return reply.code(404).send({ error: 'Admin no encontrado.' })

    disableAdmin(id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/admins/:id/enable', async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    const admin = listAdmins().find(a => a.id === id)
    if (!admin) return reply.code(404).send({ error: 'Admin no encontrado.' })

    enableAdmin(id)
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/admins/:id', async (req, reply) => {
    if (!requireSuperadmin(req, reply)) return

    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return reply.code(400).send({ error: 'ID inválido.' })

    if (id === req.admin!.id) {
      return reply.code(400).send({ error: 'No podés eliminar tu propia cuenta mientras estás logueado.' })
    }

    const admin = listAdmins().find(a => a.id === id)
    if (!admin) return reply.code(404).send({ error: 'Admin no encontrado.' })

    removeAdmin(id)
    log.info({ id, username: admin.username, by: req.admin!.username }, 'Admin eliminado.')
    return { ok: true }
  })
}
