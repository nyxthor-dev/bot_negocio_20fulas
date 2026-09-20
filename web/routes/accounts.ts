/**
 * Rutas de gestión de cuentas WhatsApp del admin logueado.
 *
 *   GET    /api/accounts              -> lista sus cuentas con estado en vivo
 *   POST   /api/accounts              -> crea una cuenta (label + teléfono)
 *   DELETE /api/accounts/:id          -> elimina la cuenta y su sesión
 *   POST   /api/accounts/:id/link     -> inicia vinculación (QR o código)
 *   GET    /api/accounts/:id/pairing  -> estado de vinculación (QR / código)
 *   POST   /api/accounts/:id/cancel   -> cancela una vinculación en curso
 *   POST   /api/accounts/:id/reconnect-> reconecta con la sesión guardada
 *   POST   /api/accounts/:id/unlink   -> logout + borra la sesión del disco
 *   POST   /api/accounts/:id/sync     -> re-sincroniza grupos/canales de la cuenta
 */

import type { FastifyInstance } from 'fastify'
import {
  insertAccount,
  getAccount,
  listAccounts,
  deleteAccount,
  countAdminGroups
} from '../../lib/db.ts'
import {
  linkAccount,
  cancelLink,
  startAccount,
  unlinkAccount,
  cleanupAccount,
  getRuntime,
  requestPairingCodeFor,
  syncGroups,
  syncNewsletters,
  hasSavedSession
} from '../../lib/client.ts'
import { isValidPhone } from '../../lib/utils.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:accounts')

function accountOwnedBy(adminId: number, accountId: number) {
  const account = getAccount(accountId)
  if (!account || account.admin_id !== adminId) return null
  return account
}

export async function registerAccountsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', async (req, reply) => {
    try {
      const accounts = listAccounts(req.admin!.id)
      const items = accounts.map(a => {
        const runtime = getRuntime(a.id)
        const live = runtime?.status ?? a.status
        return {
          id: a.id,
          label: a.label,
          phone: a.phone,
          status: live,
          db_status: a.status,
          has_session: hasSavedSession(a.id),
          admin_groups: countAdminGroups(a.id),
          created_at: a.created_at,
          last_connected_at: a.last_connected_at
        }
      })
      return { count: items.length, accounts: items }
    } catch (err) {
      log.error({ err }, 'GET /accounts')
      return reply.code(500).send({ error: 'Error listando cuentas.' })
    }
  })

  app.post('/accounts', async (req, reply) => {
    const body = req.body as { label?: string; phone?: string } | undefined
    const label = String(body?.label ?? '').trim()
    const phone = String(body?.phone ?? '').trim()

    if (!label || label.length < 2 || label.length > 60) {
      return reply.code(400).send({ error: 'El nombre de la cuenta debe tener entre 2 y 60 caracteres.' })
    }
    if (!isValidPhone(phone)) {
      return reply.code(400).send({ error: 'Teléfono inválido (7-15 dígitos, formato internacional sin + ni espacios).' })
    }

    const id = insertAccount(req.admin!.id, label, phone)
    log.info({ id, label, admin: req.admin!.username }, 'Cuenta creada.')
    return { id, label, phone, status: 'pending' }
  })

  app.delete<{ Params: { id: string } }>('/accounts/:id', async (req, reply) => {
    const accountId = parseInt(req.params.id, 10)
    if (isNaN(accountId)) return reply.code(400).send({ error: 'ID inválido.' })

    const account = accountOwnedBy(req.admin!.id, accountId)
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' })

    try {
      await cleanupAccount(accountId)
    } catch (err) {
      log.warn({ err, accountId }, 'No se pudo limpiar la sesión al eliminar (se elimina igual).')
    }
    deleteAccount(accountId)
    log.info({ accountId, admin: req.admin!.username }, 'Cuenta eliminada.')
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/accounts/:id/link', async (req, reply) => {
    const accountId = parseInt(req.params.id, 10)
    if (isNaN(accountId)) return reply.code(400).send({ error: 'ID inválido.' })

    const account = accountOwnedBy(req.admin!.id, accountId)
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' })

    const body = req.body as { method?: string } | undefined
    const method = body?.method === 'code' ? 'code' : 'qr'

    if (hasSavedSession(accountId)) {
      return reply.code(409).send({ error: 'La cuenta ya tiene sesión guardada. Usá reconectar.' })
    }

    try {
      await linkAccount(accountId, account.phone, method)
      return { ok: true, method }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'POST /accounts/:id/link')
      return reply.code(500).send({ error: 'No se pudo iniciar la vinculación.' })
    }
  })

  app.get<{ Params: { id: string } }>('/accounts/:id/pairing', async (req, reply) => {
    const accountId = parseInt(req.params.id, 10)
    if (isNaN(accountId)) return reply.code(400).send({ error: 'ID inválido.' })

    const account = accountOwnedBy(req.admin!.id, accountId)
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' })

    const runtime = getRuntime(accountId)
    return {
      id: accountId,
      label: account.label,
      phone: account.phone,
      status: runtime?.status ?? account.status,
      qr: runtime?.qrDataUrl ?? null,
      pairing_code: runtime?.pairingCode ?? null,
      last_event_at: runtime?.lastEventAt ?? null
    }
  })

  app.post<{ Params: { id: string } }>('/accounts/:id/cancel', async (req, reply) => {
    const accountId = parseInt(req.params.id, 10)
    if (isNaN(accountId)) return reply.code(400).send({ error: 'ID inválido.' })

    const account = accountOwnedBy(req.admin!.id, accountId)
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' })

    cancelLink(accountId)
    return { ok: true }
  })

  // Pedir código de 8 dígitos durante una vinculación en curso (alternativa al QR)
  app.post<{ Params: { id: string } }>('/accounts/:id/pairing-code', async (req, reply) => {
    const accountId = parseInt(req.params.id, 10)
    if (isNaN(accountId)) return reply.code(400).send({ error: 'ID inválido.' })

    const account = accountOwnedBy(req.admin!.id, accountId)
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' })

    try {
      const code = await requestPairingCodeFor(accountId)
      return { ok: true, code }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'GET /accounts/:id/pairing')
      return reply.code(500).send({ error: 'No se pudo pedir el código.' })
    }
  })

  app.post<{ Params: { id: string } }>('/accounts/:id/reconnect', async (req, reply) => {
    const accountId = parseInt(req.params.id, 10)
    if (isNaN(accountId)) return reply.code(400).send({ error: 'ID inválido.' })

    const account = accountOwnedBy(req.admin!.id, accountId)
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' })

    if (!hasSavedSession(accountId)) {
      return reply.code(409).send({ error: 'La cuenta no tiene sesión guardada. Vinculá primero.' })
    }

    try {
      await startAccount(accountId)
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'POST /accounts/:id/reconnect')
      return reply.code(500).send({ error: 'No se pudo reconectar.' })
    }
  })

  app.post<{ Params: { id: string } }>('/accounts/:id/unlink', async (req, reply) => {
    const accountId = parseInt(req.params.id, 10)
    if (isNaN(accountId)) return reply.code(400).send({ error: 'ID inválido.' })

    const account = accountOwnedBy(req.admin!.id, accountId)
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' })

    try {
      await unlinkAccount(accountId)
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'POST /accounts/:id/unlink')
      return reply.code(500).send({ error: 'No se pudo desvincular.' })
    }
  })

  app.post<{ Params: { id: string } }>('/accounts/:id/sync', async (req, reply) => {
    const accountId = parseInt(req.params.id, 10)
    if (isNaN(accountId)) return reply.code(400).send({ error: 'ID inválido.' })

    const account = accountOwnedBy(req.admin!.id, accountId)
    if (!account) return reply.code(404).send({ error: 'Cuenta no encontrada.' })

    try {
      const groupsResult = await syncGroups(accountId, true)
      const newslettersResult = await syncNewsletters(accountId, true)
      return {
        ok: true,
        total_groups: groupsResult.totalGroups,
        admin_groups: groupsResult.adminGroups,
        total_newsletters: newslettersResult.total,
        admin_newsletters: newslettersResult.adminCount
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg, accountId }, 'POST /accounts/:id/sync')
      return reply.code(500).send({ error: 'Error sincronizando (¿está conectada la cuenta?).' })
    }
  })
}
