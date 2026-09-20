/**
 * Smoke test del servidor web: arranca sin bot, hace peticiones HTTP, mata el server.
 * Valida el flujo de autenticación básico (login + cookie/token + 401).
 */
import { startWebServer, stopWebServer } from '../web/server.ts'
import { openDatabase, closeDatabase, getAdminCredentials } from '../lib/db.ts'
import { ensureAdminCredentials } from '../lib/adminAuth.ts'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { rmSync, existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = resolve(__dirname, '..', 'data', 'test-web.db')

for (const p of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  if (existsSync(p)) rmSync(p)
}

async function main() {
  console.log('--- TEST: abrir DB de test ---')
  openDatabase(TEST_DB)

  const creds = ensureAdminCredentials()
  if (!creds) {
    console.error('FAIL: se esperaban credenciales nuevas')
    process.exit(1)
  }
  const adminRow = getAdminCredentials()
  if (!adminRow || adminRow.role !== 'superadmin') {
    console.error('FAIL: el admin inicial debe ser superadmin')
    process.exit(1)
  }
  console.log('OK: superadmin inicial generado')

  console.log('--- TEST: startWebServer ---')
  const { url } = await startWebServer({ host: '127.0.0.1', port: 3999 })
  console.log('Servidor arrancó en:', url)

  console.log('--- TEST: GET / (HTML del panel) ---')
  const htmlRes = await fetch(url + '/')
  const html = await htmlRes.text()
  if (!html.includes('Publisher Manager')) {
    console.error('FAIL: el HTML no contiene "Publisher Manager"')
    process.exit(1)
  }
  if (!html.includes('login-form')) {
    console.error('FAIL: el HTML no contiene el formulario de login')
    process.exit(1)
  }
  console.log('OK: HTML del panel contiene "Publisher Manager" y login')

  console.log('--- TEST: API sin sesión → 401 ---')
  const noAuth = await fetch(url + '/api/groups?account_id=1')
  if (noAuth.status !== 401) {
    console.error('FAIL: se esperaba 401 sin sesión, fue', noAuth.status)
    process.exit(1)
  }
  console.log('OK: /api/* sin sesión devuelve 401')

  console.log('--- TEST: login correcto ---')
  const loginRes = await fetch(url + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: creds.username, password: creds.password })
  })
  const loginData = await loginRes.json().catch(() => ({}))
  if (loginRes.status !== 200 || !loginData.token) {
    console.error('FAIL: login devolvió', loginRes.status, loginData)
    process.exit(1)
  }
  console.log('OK: login devuelve token')

  console.log('--- TEST: /api/auth/status con token ---')
  const statusRes = await fetch(url + '/api/auth/status', {
    headers: { Authorization: 'Bearer ' + loginData.token }
  })
  const statusData = await statusRes.json().catch(() => ({}))
  if (statusRes.status !== 200 || statusData.admin?.username !== creds.username) {
    console.error('FAIL: status con token devolvió', statusRes.status, statusData)
    process.exit(1)
  }
  console.log('OK: status con token autentica')

  console.log('--- TEST: /api/groups autenticado (sin cuentas, con account_id inválida) ---')
  const groupsRes = await fetch(url + '/api/groups?account_id=1', {
    headers: { Authorization: 'Bearer ' + loginData.token }
  })
  const groupsData = await groupsRes.json().catch(() => ({}))
  if (groupsRes.status !== 400) {
    console.error('FAIL: se esperaba 400 (cuenta inexistente), fue', groupsRes.status)
    process.exit(1)
  }
  console.log('OK: cuenta ajena/inexistente rechazada')

  console.log('--- TEST: stopWebServer ---')
  await stopWebServer()
  console.log('OK: servidor cerrado')

  closeDatabase()
  console.log('\n✅ Todos los tests del panel pasaron correctamente.')
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
