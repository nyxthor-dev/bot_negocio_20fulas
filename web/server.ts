/**
 * Servidor web Fastify integrado al bot.
 *
 * Sirve el panel estático desde web/public/ y expone las APIs REST
 * (login, cuentas, grupos, plantillas, programaciones, publicación).
 *
 * Toda /api/* requiere sesión válida salvo /api/auth/login y
 * /api/auth/status. La sesión viaja en cookie HttpOnly (o header
 * Authorization Bearer para uso programático).
 *
 * Configurado para funcionar detrás de un reverse proxy (nginx, Caddy,
 * hidencloud, Cloudflare, etc.) con trustProxy habilitado.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { logger } from '../lib/logger.ts'
import {
  validateSessionToken,
  isLoginBlocked,
  registerLoginFailure,
  clearLoginFailures
} from '../lib/adminAuth.ts'
import { readSessionToken } from './auth.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerAccountsRoutes } from './routes/accounts.ts'
import { registerGroupsRoutes } from './routes/groups.ts'
import { registerNewslettersRoutes } from './routes/newsletters.ts'
import { registerTemplatesRoutes } from './routes/templates.ts'
import { registerSchedulesRoutes } from './routes/schedules.ts'
import { registerAdminsRoutes } from './routes/admins.ts'
import { registerPublishRoutes } from './routes/publish.ts'
import { registerMediaRoutes } from './routes/media.ts'

const log = logger('web')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, 'public')

/** Rutas de API accesibles sin sesión. */
const PUBLIC_API_PATHS = new Set(['/api/auth/login', '/api/auth/status', '/api/health'])

export interface WebServerOptions {
  host: string
  port: number
}

let server: FastifyInstance | null = null

/**
 * Arranca el servidor web en el host:port indicado.
 * Devuelve la URL base accesible.
 *
 * trustProxy: true → respeta X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host
 * Esto es crítico para que el panel funcione detrás de un reverse proxy
 * (hidencloud, nginx, Caddy, etc.) y genere URLs HTTPS correctas.
 */
export async function startWebServer(opts: WebServerOptions): Promise<{ url: string }> {
  if (server) {
    log.warn('Servidor web ya está corriendo, se ignora la llamada.')
    return { url: `http://${opts.host}:${opts.port}` }
  }

  const app = Fastify({
    logger: false,
    // 75 MB: la subida de multimedia viaja como base64 en JSON
    // (50 MB de archivo ≈ 69 MB de base64) + texto y metadatos
    bodyLimit: 75 * 1024 * 1024,
    trustProxy: true             // Crítico para reverse proxy
  })

  // CORS: sólo se refleja el Origin cuando apunta al mismo host del panel.
  // El frontend es same-origin (lo sirve este server) y los clientes
  // programáticos usan Bearer, así que un wildcard no aporta nada y amplia
  // innecesariamente la superficie de ataque.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (origin && typeof origin === 'string') {
      let host = req.headers.host
      // Detrás de proxy: el host público viene en X-Forwarded-Host
      const fwdHost = req.headers['x-forwarded-host']
      if (typeof fwdHost === 'string' && fwdHost.length > 0) host = fwdHost.split(',')[0].trim()
      try {
        const originHost = new URL(origin).host
        if (host && originHost === host) {
          reply.header('Access-Control-Allow-Origin', origin)
          reply.header('Vary', 'Origin')
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
          reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        }
      } catch { /* Origin malformado: no se refleja */ }
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send()
    }
  })

  // Cabeceras de seguridad
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'same-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (req.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=15552000') // 180 días
    }
  })

  // Autenticación: valida la sesión antes de despachar cualquier /api/*
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return

    const path = req.url.split('?')[0]

    if (!path.startsWith('/api/')) return
    if (PUBLIC_API_PATHS.has(path)) {
      // Login con rate limit por IP
      if (path === '/api/auth/login' && req.method === 'POST') {
        const ip = req.ip || 'unknown'
        if (isLoginBlocked(ip)) {
          reply.code(429).send({ error: 'Demasiados intentos fallidos. Esperá unos minutos.' })
          return
        }
      }
      return
    }

    // Anti-CSRF: los cambios de estado con cuerpo sólo aceptan JSON
    // (los formularios cross-site mandan form-urlencoded, que no puede llevar JSON)
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      const contentLength = Number(req.headers['content-length'] ?? 0)
      const chunked = req.headers['transfer-encoding'] !== undefined
      const hasBody = chunked || contentLength > 0
      if (hasBody) {
        const ct = req.headers['content-type'] ?? ''
        if (!ct.includes('application/json')) {
          reply.code(415).send({ error: 'Content-Type debe ser application/json.' })
          return
        }
      }
    }

    const token = readSessionToken(req)
    const admin = token ? validateSessionToken(token) : undefined
    if (!admin) {
      reply.code(401).send({ error: 'No autenticado.' })
      return
    }
    req.admin = admin
  })

  // Login: rate limit de intentos fallidos
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.split('?')[0] === '/api/auth/login' && req.method === 'POST') {
      const ip = req.ip || 'unknown'
      if (reply.statusCode === 401) {
        registerLoginFailure(ip)
      } else if (reply.statusCode === 200) {
        clearLoginFailures(ip)
      }
    }
  })

  // Servir archivos estáticos (HTML/CSS/JS del panel)
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html']
  })

  // Rutas API
  await app.register(async (api) => {
    // Health check público (para Render, Docker y balanceadores)
    api.get('/health', async () => ({
      ok: true,
      service: 'publisher-manager',
      uptime: Math.floor(process.uptime())
    }))

    await registerAuthRoutes(api)
    await registerAccountsRoutes(api)
    await registerGroupsRoutes(api)
    await registerNewslettersRoutes(api)
    await registerTemplatesRoutes(api)
    await registerSchedulesRoutes(api)
    await registerAdminsRoutes(api)
    await registerPublishRoutes(api)
    await registerMediaRoutes(api)
  }, { prefix: '/api' })

  server = app

  try {
    await app.listen({ host: opts.host, port: opts.port })
    const url = `http://localhost:${opts.port}`
    log.info(`Panel web escuchando en ${opts.host}:${opts.port} (URL local: ${url})`)
    log.info('Si estás detrás de un reverse proxy (nginx/Caddy/hidencloud), asegurate de:')
    log.info('  - Forwardear HTTP/HTTPS al puerto local ' + opts.port)
    log.info('  - Pasar las cabeceras Host, X-Forwarded-For, X-Forwarded-Proto')
    return { url }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`No se pudo levantar el servidor web en ${opts.host}:${opts.port} — ${msg}`)
    if (msg.includes('EADDRINUSE')) {
      log.error('El puerto ya está en uso. Cambiá web.port en config.json o detené el proceso que lo ocupa.')
    } else if (msg.includes('EACCES')) {
      log.error('Permiso denegado para ese puerto. Usá un puerto >= 1024 o ejecutá con permisos suficientes.')
    }
    server = null
    throw err
  }
}

/** Detiene el servidor web limpiamente. */
export async function stopWebServer(): Promise<void> {
  if (server) {
    log.info('Cerrando servidor web…')
    await server.close()
    server = null
  }
}
