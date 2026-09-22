/**
 * Rutas de autenticación del panel.
 *
 *   POST /api/auth/login   -> valida credenciales, crea sesión y fija la cookie
 *   GET  /api/auth/status  -> quién está logueado (401 si nadie)
 *   POST /api/auth/logout  -> cierra la sesión actual
 */

import type { FastifyInstance } from 'fastify'
import {
  loginWithCredentials,
  logoutToken,
  validateSessionToken,
  SESSION_TTL_MS,
  isUserLoginBlocked,
  registerUserLoginFailure,
  clearUserLoginFailures
} from '../../lib/adminAuth.ts'
import { readSessionToken, setSessionCookie, clearSessionCookie } from '../auth.ts'
import { logger } from '../../lib/logger.ts'

const log = logger('routes:auth')

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    const body = req.body as { username?: string; password?: string } | undefined
    const username = String(body?.username ?? '').trim()
    const password = String(body?.password ?? '')

    if (!username || !password) {
      return reply.code(400).send({ error: 'Usuario y contraseña son requeridos.' })
    }

    // Bloqueo por USUARIO (además del de por IP del hook de server.ts):
    // inmune al spoofing de X-Forwarded-For — aunque roten las IPs, la
    // cuenta objetivo queda bloqueada tras varios intentos fallidos.
    if (isUserLoginBlocked(username)) {
      return reply.code(429).send({ error: 'Demasiados intentos fallidos. Esperá unos minutos.' })
    }

    // Pequeña pausa para frenar fuerza bruta automatizada
    await new Promise(r => setTimeout(r, 300))

    const result = loginWithCredentials(username, password)
    if (!result.ok) {
      registerUserLoginFailure(username)
      log.warn(`Login fallido para "${username}" desde ${req.ip}.`)
      return reply.code(401).send({ error: result.error })
    }

    clearUserLoginFailures(username)
    setSessionCookie(req, reply, result.token!, Math.floor(SESSION_TTL_MS / 1000))
    // Nota: no devolvemos el token en el body. La cookie HttpOnly basta y sobre
    // (el frontend usa la cookie automaticamente via fetch credentials: 'include').
    // Exponerlo en JSON es redundante y aumenta la superficie de fuga
    // (p.ej. si un atacante logra leer responses del navegador via XS-Leak).
    return { ok: true, admin: result.admin }
  })

  app.get('/auth/status', async (req, reply) => {
    const token = readSessionToken(req)
    const admin = token ? validateSessionToken(token) : undefined
    if (!admin) {
      return reply.code(401).send({ error: 'No autenticado.' })
    }
    return { authenticated: true, admin: { id: admin.id, username: admin.username, role: admin.role } }
  })

  app.post('/auth/logout', async (req, reply) => {
    const token = readSessionToken(req)
    if (token) {
      logoutToken(token)
    }
    clearSessionCookie(reply)
    return { ok: true }
  })
}
