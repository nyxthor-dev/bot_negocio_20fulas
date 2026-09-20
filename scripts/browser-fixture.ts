/**
 * Fixture para probar el panel en un navegador.
 * Arranca el web server con una DB de test y datos sembrados:
 * superadmin tester/clave12345, 2 cuentas, grupos, plantilla y programación.
 *
 * El proceso queda corriendo hasta Ctrl+C.
 */
import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { silenceConsoleNoise } from '../lib/consoleFilter.ts'

silenceConsoleNoise()

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TEST_DB = resolve(ROOT, 'data', 'test-browser.db')
const TEST_AUTH = resolve(ROOT, 'data', 'test-auth')
const TEST_MEDIA = resolve(ROOT, 'data', 'test-media')

for (const p of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  if (existsSync(p)) rmSync(p)
}
if (existsSync(TEST_AUTH)) rmSync(TEST_AUTH, { recursive: true, force: true })
if (existsSync(TEST_MEDIA)) rmSync(TEST_MEDIA, { recursive: true, force: true })
mkdirSync(TEST_MEDIA, { recursive: true })

const db = await import('../lib/db.ts')
db.openDatabase(TEST_DB)

const auth = await import('../lib/adminAuth.ts')
const mk = auth.createAdmin('tester', 'clave12345', 'superadmin')
if (!mk.ok) {
  console.error('No se pudo crear el admin de test:', mk.error)
  process.exit(1)
}
const adminId = mk.id!
auth.createAdmin('segundo', 'clave67890', 'admin')

// Datos sembrados
const acc1 = db.insertAccount(adminId, 'Número principal', '549111111111')
const acc2 = db.insertAccount(adminId, 'Secundaria', '549222222222')
db.updateAccountStatus(acc1, 'connected')
db.touchAccountConnected(acc1)
db.upsertGroup({ account_id: acc1, jid: '111@g.us', name: 'Grupo Alpha', is_admin: 1, is_owner: 1, can_send: 1 })
db.upsertGroup({ account_id: acc1, jid: '222@g.us', name: 'Grupo Beta', is_admin: 1, is_owner: 0, can_send: 1 })
db.upsertGroup({ account_id: acc1, jid: '444@g.us', name: 'Grupo Delta (solo miembro)', is_admin: 0, is_owner: 0, can_send: 1 })
db.upsertGroup({ account_id: acc1, jid: '666@g.us', name: 'Grupo Epsilon (solo admins escriben)', is_admin: 0, is_owner: 0, can_send: 0 })
db.upsertGroup({ account_id: acc1, jid: '555@newsletter', name: 'Canal Noticias', is_admin: 1, is_owner: 0, can_send: 1 })
db.upsertGroup({ account_id: acc2, jid: '333@g.us', name: 'Grupo Gamma', is_admin: 1, is_owner: 0, can_send: 1 })
// Grupo compartido: ambas cuentas tienen 333@g.us → permite verificar el
// selector "⇄ Enviar con" (elección de cuenta para duplicados) en el panel.
db.upsertGroup({ account_id: acc1, jid: '333@g.us', name: 'Grupo Gamma', is_admin: 1, is_owner: 0, can_send: 1 })

// Plantilla con imagen (para probar multimedia + caption)
const mediaMod = await import('../lib/media.ts')
mediaMod.configureMediaDir(TEST_MEDIA)
const pngB64 = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64')
const savedMedia = mediaMod.saveMediaFromBase64({ adminId, base64: pngB64, mimeType: 'image/png', fileName: 'promo.png' })
const mediaId = savedMedia.ok ? savedMedia.media.id : null

db.insertTemplate(adminId, 'Promo fin de semana', 'Aprovechá el *20% off* este sábado y domingo!', JSON.stringify({ forwarded: true }))
db.insertTemplate(adminId, 'Aviso general', 'Recordatorio: el grupo se mantiene activo todos los días.', null)
db.insertTemplate(adminId, 'Promo con imagen', 'Oferta flash — solo por hoy!', null, mediaId)

const schedId = db.insertSchedule({
  admin_id: adminId,
  name: 'Buenos días',
  sched_type: 'daily',
  scheduled_at: null,
  recur_time: 9 * 60,
  recur_times: JSON.stringify([9 * 60, 15 * 60]),
  recur_dow: null,
  recur_dom: null,
  interval_minutes: null,
  window_start: null,
  window_end: null,
  tz_offset_min: new Date().getTimezoneOffset(),
  next_run_at: Date.now() + 3600_000
})
db.insertScheduleMessage(schedId, acc1, ['111@g.us', '222@g.us'], '¡Buen día! Promo activa hoy.', null)
const schedInterval = db.insertSchedule({
  admin_id: adminId,
  name: 'Cada 2 horas (laboral)',
  sched_type: 'interval',
  scheduled_at: null,
  recur_time: null,
  recur_times: null,
  recur_dow: null,
  recur_dom: null,
  interval_minutes: 120,
  window_start: 9 * 60,
  window_end: 18 * 60,
  tz_offset_min: new Date().getTimezoneOffset(),
  next_run_at: Date.now() + 3600_000
})
db.insertScheduleMessage(schedInterval, acc2, ['333@g.us'], 'Recordatorio cada 2 horas.', null, mediaId)

// Programación con duplicados + elección de cuenta (assign_map persistido)
const schedAssign = db.insertSchedule({
  admin_id: adminId,
  name: 'Elección de cuenta',
  sched_type: 'daily',
  scheduled_at: null,
  recur_time: 12 * 60,
  recur_times: JSON.stringify([12 * 60]),
  recur_dow: null,
  recur_dom: null,
  interval_minutes: null,
  window_start: null,
  window_end: null,
  tz_offset_min: new Date().getTimezoneOffset(),
  next_run_at: Date.now() + 7200_000,
  assign_map: JSON.stringify({ '333@g.us': acc2 })
})
db.insertScheduleMessage(schedAssign, acc1, ['333@g.us'], 'Mediodía por la elegida A.', null)
db.insertScheduleMessage(schedAssign, acc2, ['333@g.us'], 'Mediodía por la elegida B.', null)

const client = await import('../lib/client.ts')
client.configureAuthRoot(TEST_AUTH)

const web = await import('../web/server.ts')
const { url } = await web.startWebServer({ host: '127.0.0.1', port: 4555 })

console.log('\n========================================')
console.log('Panel de test listo en:', url)
console.log('Usuario: tester / clave: clave12345 (superadmin)')
console.log('Segundo admin: segundo / clave67890')
console.log('========================================\n')
