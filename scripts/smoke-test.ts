/**
 * Test rápido de smoke: verifica que el bootstrap del bot funciona sin error.
 * No conecta a WhatsApp — sólo valida DB + admin bootstrap + builders.
 */
import { openDatabase, closeDatabase, getAdminCredentials } from '../lib/db.ts'
import { ensureAdminCredentials, loginWithCredentials } from '../lib/adminAuth.ts'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { rmSync, existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = resolve(__dirname, '..', 'data', 'test-smoke.db')

for (const p of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  if (existsSync(p)) rmSync(p)
}

console.log('--- TEST: openDatabase ---')
openDatabase(TEST_DB)

console.log('--- TEST: ensureAdminCredentials (primera vez) ---')
const creds = ensureAdminCredentials()
if (!creds) {
  console.error('FAIL: se esperaban credenciales nuevas pero ensureAdminCredentials devolvió null')
  process.exit(1)
}
console.log(`Usuario generado: ${creds.username}`)
console.log(`Password generada: ${creds.password}`)

console.log('--- TEST: ensureAdminCredentials (segunda vez, debe devolver null) ---')
const creds2 = ensureAdminCredentials()
if (creds2) {
  console.error('FAIL: se esperaba null en segunda llamada pero devolvió credenciales')
  process.exit(1)
}
console.log('OK: segunda llamada devolvió null como se esperaba')

console.log('--- TEST: loginWithCredentials con credenciales correctas ---')
const ok = loginWithCredentials(creds.username, creds.password)
if (!ok.ok) {
  console.error('FAIL: login debió devolver ok para credenciales correctas')
  process.exit(1)
}
console.log('OK: login correcto verificado (rol: ' + ok.admin?.role + ')')

console.log('--- TEST: loginWithCredentials con password incorrecta ---')
const bad = loginWithCredentials(creds.username, 'password-incorrecta')
if (bad.ok) {
  console.error('FAIL: login debió devolver false para password incorrecta')
  process.exit(1)
}
console.log('OK: password incorrecta rechazada')

console.log('--- TEST: getAdminCredentials recupera de DB ---')
const row = getAdminCredentials()
if (!row) {
  console.error('FAIL: getAdminCredentials debió devolver la fila')
  process.exit(1)
}
console.log(`OK: fila recuperada. username=${row.username}, role=${row.role}, hash prefix=${row.password_hash.slice(0, 7)}...`)

console.log('--- TEST: buildMessage con decoraciones ---')
const { buildMessage } = await import('../lib/textDecorations.ts')
const msg = buildMessage({
  text: '*Hola* _mundo_',
  decorations: {
    forwarded: true,
    forwardingScore: 25,
    parseMarkdown: false,
    mentions: [{ phone: '5491112345678' }]
  }
})
if (!msg) {
  console.error('FAIL: buildMessage devolvió undefined')
  process.exit(1)
}
console.log('OK: buildMessage OK. text=' + (msg as { text?: string }).text)

console.log('--- TEST: buildTemplateButtonsMessage ---')
const { buildTemplateButtonsMessage, urlButton, replyButton, callButton } = await import('../lib/interactiveButtons.ts')
const tmpl = buildTemplateButtonsMessage({
  text: 'Elegí una opción:',
  title: 'Menú',
  footer: 'Publisher Manager',
  buttons: [
    replyButton('Responder', 'r1'),
    urlButton('Visitar web', 'https://ejemplo.com'),
    callButton('Llamar', '5491112345678')
  ]
})
if (!tmpl) {
  console.error('FAIL: buildTemplateButtonsMessage devolvió undefined')
  process.exit(1)
}
console.log('OK: template buttons OK. hydratedButtons count=' + tmpl.hydratedFourRowTemplate?.hydratedButtons?.length)

console.log('--- TEST: buildListMessage ---')
const { buildListMessage } = await import('../lib/interactiveButtons.ts')
const list = buildListMessage({
  text: 'Elegí categoría:',
  buttonText: 'Ver opciones',
  title: 'Catálogo',
  sections: [
    {
      title: 'Frutas',
      rows: [
        { id: 'f1', title: 'Manzana', description: 'Roja' },
        { id: 'f2', title: 'Banana' }
      ]
    }
  ]
})
if (!list) {
  console.error('FAIL: buildListMessage devolvió undefined')
  process.exit(1)
}
console.log('OK: list message OK. sections count=' + list.sections?.length)

closeDatabase()
console.log('\n✅ Todos los tests pasaron correctamente.')
