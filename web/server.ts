/**
 * Servidor web Fastify integrado al bot.
 *
 * Sirve el panel estático desde web/public/ y expone las APIs REST
 * para publicar a grupos/canales donde el bot es admin.
 *
 * Configurado para funcionar detrás de un reverse proxy (nginx, Caddy,
 * hidencloud, Cloudflare, etc.) con trustProxy habilitado.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import multipart from '@fastify/multipart'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { logger } from '../lib/logger.ts'
import { registerPublishRoutes } from './routes/publish.ts'
import { registerGroupsRoutes } from './routes/groups.ts'
import { registerNewslettersRoutes } from './routes/newsletters.ts'

const log = logger('web')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = resolve(__dirname, 'public')

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
    bodyLimit: 60 * 1024 * 1024,  // 60 MB para texto + media
    trustProxy: true            // Crítico para reverse proxy
  })

  // Registrar multipart para subir archivos multimedia
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024  // 50 MB por archivo
    }
  })

  // CORS mínimo para que el frontend pueda llamar a la API sin problemas
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') {
      reply.code(204).send()
    }
  })

  // Cabecera X-Content-Type-Options para seguridad extra
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
  })

  // Servir archivos estáticos (HTML/CSS/JS del panel)
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html']
  })

  // Rutas API
  await app.register(async (api) => {
    await registerGroupsRoutes(api)
    await registerNewslettersRoutes(api)
    await registerPublishRoutes(api)
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
