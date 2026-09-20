/**
 * Helpers de autenticación compartidos por las rutas del panel.
 *
 * El hook onRequest de server.ts valida la sesión y deja req.admin listo;
 * acá viven las utilidades para leer el token (cookie o header Bearer)
 * y para los checks de rol que usan las rutas protegidas.
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AdminRow } from '../lib/db.ts'

export const SESSION_COOKIE = 'pm_sess'

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminRow
  }
}

/** Lee el token de sesión: primero cookie, después header Authorization Bearer. */
export function readSessionToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim()
    if (token.length > 0) return token
  }

  const cookieHeader = req.headers.cookie
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) {
      // Cookie corrupta (% suelto, etc.): se trata como "sin sesión" en vez
      // de dejar que el URIError tumbe el hook de auth con un 500.
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Fija la cookie de sesión en la respuesta.
 * La flag Secure se activa cuando la request llega por HTTPS (directo o
 * detrás de reverse proxy con trustProxy), para no romper pruebas en HTTP local.
 */
export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  const secure = req.protocol === 'https' ? '; Secure' : ''
  reply.header('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAgeSeconds}`)
}

/** Borra la cookie de sesión. */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/** 403 con mensaje estándar para rutas de superadmin. */
export function requireSuperadmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.admin?.role !== 'superadmin') {
    reply.code(403).send({ error: 'Sólo el superadmin puede hacer esto.' })
    return false
  }
  return true
}
