/**
 * Simula un arranque estilo Render/Docker: sin config.json, sólo variables
 * de entorno. Verifica: fallback de config, PORT dinámico, health check,
 * bootstrap del superadmin desde ADMIN_USER/ADMIN_PASSWORD, login y logout.
 *
 * No conecta a WhatsApp.
 */

import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DATA_DIR = resolve(ROOT, 'data', 'test-render')
const PORT = 4567
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
let failed = 0

function ok (name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}`)
  } else {
    failed++
    console.error(`  [FAIL] ${name} ${extra}`)
  }
}

async function main () {
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })

  process.env.WEB_ENABLED = 'true'
  process.env.PORT = String(PORT)
  process.env.DATA_DIR = DATA_DIR
  process.env.ADMIN_USER = 'renderadmin'
  process.env.ADMIN_PASSWORD = 'ClaveRender123'
  process.env.LOG_LEVEL = 'warn'
  // Desactivar rate limiting durante los tests.
  process.env.RATE_LIMIT_DISABLED = '1'
  delete process.env.HOST

  console.log('\n=== Boot simulado estilo Render (sin config.json) ===')

  // Import diferido: la config se cachea en el primer loadConfig()
  const config = await import('../lib/config.ts')
  const cfg = config.loadConfig()
  ok('sin config.json no lanza error (WEB_ENABLED presente)', true)
  ok('web.enabled del entorno', cfg.web.enabled === true)
  ok('PORT del entorno pisa el default', cfg.web.port === PORT)
  ok('DATA_DIR redirige storage', cfg.storage.dbPath === `${DATA_DIR}/bot.db` && cfg.storage.authFolder === `${DATA_DIR}/auth`)
  ok('LOG_LEVEL del entorno', cfg.logging.level === 'warn')

  // WhatsApp no está cableado aquí: abrimos DB + panel como hace index.ts
  const db = await import('../lib/db.ts')
  db.openDatabase(`${DATA_DIR}/bot.db`)
  const auth = await import('../lib/adminAuth.ts')
  const creds = auth.ensureAdminCredentials()
  ok('bootstrap desde ADMIN_USER/ADMIN_PASSWORD devuelve null (no imprime password)', creds === null)

  const { startWebServer, stopWebServer } = await import('../web/server.ts')
  await startWebServer({ host: '0.0.0.0', port: PORT })

  console.log('\n=== HTTP ===')
  const health = await fetch(`${BASE}/api/health`)
  const healthBody = await health.json() as { ok?: boolean }
  ok('GET /api/health → 200 sin sesión', health.status === 200 && healthBody.ok === true)

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'renderadmin', password: 'ClaveRender123' })
  })
  const loginBody = await login.json() as { ok?: boolean; admin?: { role?: string } }
  ok('login con credenciales de entorno → 200', login.status === 200 && loginBody.ok === true)
  // Token ya no viene en body; se extrae de Set-Cookie para los tests que lo usan como Bearer.
  const setCookie = login.headers.get('set-cookie') ?? ''
  const tokenMatch = setCookie.match(/pm_sess=([^;]+)/)
  const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : ''
  ok('setea cookie pm_sess', token.length > 20)
  ok('rol superadmin', loginBody.admin?.role === 'superadmin')

  const wrong = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'renderadmin', password: 'incorrecta' })
  })
  ok('login con password incorrecta → 401', wrong.status === 401)

  const noAuth = await fetch(`${BASE}/api/accounts`)
  ok('API protegida sin sesión → 401', noAuth.status === 401)

  const withToken = await fetch(`${BASE}/api/accounts`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  ok('API con Bearer token → 200', withToken.status === 200)

  const status = await fetch(`${BASE}/api/auth/status`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const statusBody = await status.json() as { authenticated?: boolean }
  ok('GET /api/auth/status autenticado', status.status === 200 && statusBody.authenticated === true)

  const logout = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  })
  ok('logout → 200', logout.status === 200)

  const afterLogout = await fetch(`${BASE}/api/accounts`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  ok('token revocado tras logout → 401', afterLogout.status === 401)

  await stopWebServer()
  db.closeDatabase()

  ok('SQLite creado en DATA_DIR', existsSync(`${DATA_DIR}/bot.db`))

  // Limpieza
  rmSync(DATA_DIR, { recursive: true, force: true })

  console.log(`\n=== Resultado: ${passed} PASS, ${failed} FAIL ===`)
  if (failed === 0) {
    console.log('✅ Boot estilo Render verificado.')
    process.exit(0)
  }
  process.exit(1)
}

main().catch((err) => {
  console.error('Error fatal del test:', err)
  process.exit(1)
})
