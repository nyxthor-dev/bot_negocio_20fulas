/**
 * Test integral: DB + migraciones + auth + multi-cuenta + plantillas +
 * programaciones + scheduler + panel web con sesiones.
 *
 * No conecta a WhatsApp — los envíos se simulan con un sendFn mock.
 */

import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TEST_DB = resolve(ROOT, 'data', 'test-full.db')
const TEST_AUTH = resolve(ROOT, 'data', 'test-auth')
const TEST_MEDIA = resolve(ROOT, 'data', 'test-media')

let passed = 0
let failed = 0

function ok (name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}`)
  } else {
    failed++
    console.error(`  [FAIL] ${name} ${extra}`)
  }
}

async function main () {
  // Limpieza de corridas anteriores
  for (const p of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    if (existsSync(p)) rmSync(p)
  }
  if (existsSync(TEST_AUTH)) rmSync(TEST_AUTH, { recursive: true, force: true })
  mkdirSync(TEST_AUTH, { recursive: true })
  if (existsSync(TEST_MEDIA)) rmSync(TEST_MEDIA, { recursive: true, force: true })

  /* ================== 0. Deduplicación entre cuentas ================== */
  console.log('\n=== 0. Deduplicación de destinos entre cuentas ===')
  {
    const { dedupeCrossAccount } = await import('../lib/dedupe.ts')
    const entrada = [
      { accountId: 1, jids: ['111@g.us', '222@g.us', '555@newsletter'] },
      { accountId: 2, jids: ['222@g.us', '333@g.us'] },
      { accountId: 3, jids: ['222@g.us'] }
    ]
    const { items, skipped } = dedupeCrossAccount(entrada)
    ok('dedupe: cuenta 1 conserva todos sus destinos', JSON.stringify(items[0].jids) === JSON.stringify(['111@g.us', '222@g.us', '555@newsletter']))
    ok('dedupe: cuenta 2 pierde el grupo repetido', JSON.stringify(items[1].jids) === JSON.stringify(['333@g.us']))
    ok('dedupe: cuenta 3 queda sin destinos (todos repetidos)', items[2].jids.length === 0)
    ok('dedupe: 2 destinos omitidos', skipped.length === 2)
    ok('dedupe: el destino queda asignado a la primera cuenta', skipped.every(s => s.keptByAccountId === 1) && skipped.some(s => s.accountId === 2) && skipped.some(s => s.accountId === 3))
    ok('dedupe: no muta los items de entrada', entrada[1].jids.length === 2 && entrada[2].jids.length === 1)
    ok('dedupe: mantiene el orden de los items', items[0].accountId === 1 && items[1].accountId === 2 && items[2].accountId === 3)

    // Elección del usuario (assign): la cuenta elegida se queda el destino
    const entrada2 = [
      { accountId: 1, jids: ['dup@g.us', 'solo1@g.us'] },
      { accountId: 2, jids: ['dup@g.us', 'solo2@g.us'] }
    ]
    const conAssign = dedupeCrossAccount(entrada2, { 'dup@g.us': 2 })
    ok('assign: cuenta elegida (2) conserva el duplicado', conAssign.items[1].jids.includes('dup@g.us'))
    ok('assign: cuenta 1 pierde el duplicado pero conserva el suyo', !conAssign.items[0].jids.includes('dup@g.us') && conAssign.items[0].jids.includes('solo1@g.us'))
    ok('assign: el omitido apunta a la cuenta elegida', conAssign.skipped.length === 1 && conAssign.skipped[0].accountId === 1 && conAssign.skipped[0].keptByAccountId === 2)

    // Assign inválido → fallback determinista (primera cuenta)
    const conAssignRoto = dedupeCrossAccount(entrada2, { 'dup@g.us': 99 })
    ok('assign a cuenta ajena → fallback primera', conAssignRoto.items[0].jids.includes('dup@g.us') && !conAssignRoto.items[1].jids.includes('dup@g.us'))

    // Assign válido pero el jid está duplicado intra-item → se elimina en silencio
    const intra = [{ accountId: 1, jids: ['rep@g.us', 'rep@g.us', 'otro@g.us'] }]
    const resIntra = dedupeCrossAccount(intra)
    ok('duplicado intra-item se elimina en silencio', resIntra.items[0].jids.length === 2 && resIntra.skipped.length === 0)

    // Assign a cuenta que participa pero no tiene ese jid → fallback
    const entrada3 = [
      { accountId: 1, jids: ['x@g.us'] },
      { accountId: 2, jids: ['x@g.us'] }
    ]
    const conAssignParcial = dedupeCrossAccount(entrada3, { 'x@g.us': 2, 'otro@g.us': 1 })
    ok('assign parcial: la válida aplica', conAssignParcial.items[1].jids.includes('x@g.us'))
  }

  /* =========================== 1. DB fresh =========================== */
  console.log('\n=== 1. Esquema nuevo desde cero ===')
  const db = (await import('../lib/db.ts'))
  db.openDatabase(TEST_DB)

  const tables = db._debugListTables()
  for (const t of ['admin_credentials', 'auth_sessions', 'wa_accounts', 'groups_cache', 'templates', 'schedules', 'schedule_messages', 'publish_batch', 'publish_log']) {
    ok(`tabla ${t} existe`, tables.includes(t))
  }
  const groupCols = db._debugListColumns('groups_cache')
  ok('groups_cache tiene account_id', groupCols.includes('account_id'))
  const batchCols = db._debugListColumns('publish_batch')
  ok('publish_batch tiene admin_id/account_id/schedule_id', batchCols.includes('admin_id') && batchCols.includes('account_id') && batchCols.includes('schedule_id'))
  const schedColsNew = db._debugListColumns('schedules')
  ok('schedules tiene assign_map', schedColsNew.includes('assign_map'))

  /* ======================= 2. Bootstrap superadmin ==================== */
  console.log('\n=== 2. Bootstrap del superadmin ===')
  const auth = await import('../lib/adminAuth.ts')

  const creds = auth.ensureAdminCredentials()
  ok('primera ejecución genera credenciales', !!creds && creds.username === 'admin')
  const creds2 = auth.ensureAdminCredentials()
  ok('segunda ejecución devuelve null', creds2 === null)

  const loginOk = auth.loginWithCredentials('admin', creds!.password)
  ok('login correcto devuelve token', loginOk.ok && !!loginOk.token && loginOk.admin!.role === 'superadmin')
  const loginBad = auth.loginWithCredentials('admin', 'password-incorrecta')
  ok('login incorrecto rechazado', !loginBad.ok)
  const tokenSuperadmin = loginOk.token!

  const sessionAdmin = auth.validateSessionToken(tokenSuperadmin)
  ok('validateSessionToken recupera al admin', sessionAdmin?.username === 'admin' && sessionAdmin?.role === 'superadmin')
  ok('token inventado no valida', auth.validateSessionToken('f'.repeat(64)) === undefined)

  const mk = auth.createAdmin('juan', 'clave12345', 'admin')
  ok('createAdmin ok', mk.ok)
  const mkDup = auth.createAdmin('juan', 'otraclave123', 'admin')
  ok('createAdmin rechaza duplicado', !mkDup.ok)
  const mkShort = auth.createAdmin('pedro', 'corta', 'admin')
  ok('createAdmin rechaza password corta', !mkShort.ok)

  const resetRes = auth.resetAdminPassword('juan', 'nuevaclave999')
  ok('resetPassword ok', resetRes.ok)
  const loginJuan = auth.loginWithCredentials('juan', 'nuevaclave999')
  ok('juan loguea con la nueva password', loginJuan.ok)

  auth.disableAdmin(loginJuan.admin!.id)
  const loginJuanDisabled = auth.loginWithCredentials('juan', 'nuevaclave999')
  ok('admin deshabilitado no loguea', !loginJuanDisabled.ok)
  const tokenJuan = loginJuan.token // token previo al disable
  ok('sesión de admin deshabilitado invalidada', auth.validateSessionToken(tokenJuan!) === undefined)
  auth.enableAdmin(loginJuan.admin!.id)
  const loginJuan2 = auth.loginWithCredentials('juan', 'nuevaclave999')
  ok('admin re-habilitado vuelve a loguear', loginJuan2.ok)
  const tokenJuan2 = loginJuan2.token!

  // Bloqueo por USUARIO tras varios fallos (inmune a rotación de IP spoofing)
  for (let i = 0; i < 6; i++) auth.registerUserLoginFailure('juan')
  ok('lockout por usuario activo tras 6 fallos', auth.isUserLoginBlocked('juan'))
  ok('lockout por usuario no afecta a otro', !auth.isUserLoginBlocked('admin'))
  auth.clearUserLoginFailures('juan')
  ok('lockout por usuario se limpia al loguear bien', !auth.isUserLoginBlocked('juan'))
  // Timing: usuario inexistente no se distingue por el resultado
  const ghost = auth.loginWithCredentials('usuario-fantasma-xyz', 'claverara123')
  ok('usuario inexistente → mismo error genérico', !ghost.ok && ghost.error === 'Usuario o contraseña incorrectos.')

  /* ==================== 3. Cuentas + grupos por cuenta ================ */
  console.log('\n=== 3. Cuentas y grupos por cuenta ===')
  const adminId = sessionAdmin!.id
  const juanId = loginJuan2.admin!.id

  const acc1 = db.insertAccount(adminId, 'Número principal', '549111111111')
  const acc2 = db.insertAccount(adminId, 'Secundaria', '549222222222')
  const accJuan = db.insertAccount(juanId, 'Cuenta de Juan', '549333333333')
  ok('cuentas creadas con ids distintos', acc1 > 0 && acc2 > 0 && accJuan > 0)

  db.upsertGroup({ account_id: acc1, jid: '111@g.us', name: 'Grupo A', is_admin: 1, is_owner: 1, can_send: 1 })
  db.upsertGroup({ account_id: acc1, jid: '222@g.us', name: 'Grupo B', is_admin: 1, is_owner: 0, can_send: 1 })
  db.upsertGroup({ account_id: acc1, jid: '333@g.us', name: 'Grupo C', is_admin: 0, is_owner: 0, can_send: 1 })
  db.upsertGroup({ account_id: acc1, jid: '334@g.us', name: 'Grupo C2 (restringido)', is_admin: 0, is_owner: 0, can_send: 0 })
  db.upsertGroup({ account_id: acc2, jid: '444@g.us', name: 'Grupo D', is_admin: 1, is_owner: 0, can_send: 1 })
  db.upsertGroup({ account_id: accJuan, jid: '555@g.us', name: 'Grupo de Juan', is_admin: 1, is_owner: 0, can_send: 1 })
  db.upsertGroup({ account_id: acc1, jid: '999@newsletter', name: 'Canal X', is_admin: 1, is_owner: 0, can_send: 1 })

  const acc1Groups = db.getAdminGroups(acc1)
  ok('cuenta 1 ve 3 grupos admin (2 grupos + canal)', acc1Groups.length === 3, `obtuvo ${acc1Groups.length}`)
  const acc2Groups = db.getAdminGroups(acc2)
  ok('cuenta 2 ve SOLO su grupo (aislamiento por cuenta)', acc2Groups.length === 1 && acc2Groups[0].name === 'Grupo D')
  ok('grupo no-admin excluido', !acc1Groups.some(g => g.jid === '333@g.us'))

  db.touchAccountConnected(acc1)
  ok('touchAccountConnected marca conectada', db.getAccount(acc1)?.status === 'connected')

  /* ======================== 4. Plantillas ============================= */
  console.log('\n=== 4. Plantillas ===')
  const t1 = db.insertTemplate(adminId, 'Promo A', 'Texto *promo* A', JSON.stringify({ forwarded: true }))
  db.insertTemplate(juanId, 'Plantilla de Juan', 'texto juan', null)
  const own = db.listTemplates(adminId)
  ok('el superadmin sólo ve sus plantillas', own.length === 1 && own[0].name === 'Promo A')
  db.updateTemplate(t1, adminId, 'Promo A v2', 'Texto nuevo', null)
  ok('updateTemplate funciona', db.getTemplate(t1, adminId)?.text === 'Texto nuevo')
  ok('plantilla de otro admin inaccesible', db.getTemplate(db.listTemplates(juanId)[0].id, adminId) === undefined)

  /* ==================== 5. Programaciones (DB) ======================== */
  console.log('\n=== 5. Programaciones en DB ===')
  const sched1 = db.insertSchedule({
    admin_id: adminId,
    name: 'Una vez',
    sched_type: 'once',
    scheduled_at: Date.now() + 3_600_000,
    recur_time: null, recur_times: null, recur_dow: null, recur_dom: null,
    interval_minutes: null, window_start: null, window_end: null,
    tz_offset_min: 0,
    next_run_at: Date.now() + 3_600_000
  })
  db.insertScheduleMessage(sched1, acc1, ['111@g.us', '999@newsletter'], 'Mensaje programado', null)
  const scheds = db.listSchedules(adminId)
  ok('schedule creada con mensaje', scheds.length === 1 && db.listScheduleMessages(sched1).length === 1)
  ok('json de destinos redondo', JSON.parse(db.listScheduleMessages(sched1)[0].target_jids).length === 2)

  /* ==================== 6. Cálculo de recurrencias ==================== */
  console.log('\n=== 6. computeNextRun / resolveNextRun ===')
  const sched = await import('../lib/scheduler.ts')

  // Referencia fija: miércoles 2026-01-14 10:30 UTC (tz offset 0)
  const WED = Date.UTC(2026, 0, 14, 10, 30, 0, 0)

  const dailyToday = sched.computeNextRun('daily', [11 * 60], null, null, 0, WED)
  ok('daily hoy 11:00 (aún no llegó)', dailyToday === Date.UTC(2026, 0, 14, 11, 0))
  const dailyTomorrow = sched.computeNextRun('daily', [10 * 60], null, null, 0, WED)
  ok('daily 10:00 ya pasó → mañana', dailyTomorrow === Date.UTC(2026, 0, 15, 10, 0))

  // Multi-horario: 9:00 ya pasó, 14:30 y 20:00 todavía no → hoy a las 14:30
  const multiTimes = sched.computeNextRun('daily', [9 * 60, 14 * 60 + 30, 20 * 60], null, null, 0, WED)
  ok('daily con 3 horarios toma el próximo de HOY', multiTimes === Date.UTC(2026, 0, 14, 14, 30), `obtuvo ${multiTimes}`)
  // Todos los horarios de hoy pasaron → primero de mañana
  const allPassed = sched.computeNextRun('daily', [9 * 60, 10 * 60], null, null, 0, WED)
  ok('daily todos pasados → mañana al primero', allPassed === Date.UTC(2026, 0, 15, 9, 0))
  // Sin horarios → null
  ok('daily sin horarios → null', sched.computeNextRun('daily', [], null, null, 0, WED) === null)

  const weeklySame = sched.computeNextRun('weekly', [12 * 60], 3, null, 0, WED) // 3 = miércoles
  ok('weekly mismo día a futuro', weeklySame === Date.UTC(2026, 0, 14, 12, 0))
  const weeklyNext = sched.computeNextRun('weekly', [9 * 60], 4, null, 0, WED) // 4 = jueves
  ok('weekly próximo jueves', weeklyNext === Date.UTC(2026, 0, 15, 9, 0))
  const weeklyPast = sched.computeNextRun('weekly', [9 * 60], 3, null, 0, WED) // miércoles 9:00 ya pasó
  ok('weekly pasado → próxima semana', weeklyPast === Date.UTC(2026, 0, 21, 9, 0))
  const weeklyMulti = sched.computeNextRun('weekly', [9 * 60, 13 * 60], 3, null, 0, WED)
  ok('weekly multi-horario toma el próximo de hoy', weeklyMulti === Date.UTC(2026, 0, 14, 13, 0))

  const monthlyThis = sched.computeNextRun('monthly', [8 * 60], null, 20, 0, WED)
  ok('monthly día 20 de enero', monthlyThis === Date.UTC(2026, 0, 20, 8, 0))
  const monthlyNext = sched.computeNextRun('monthly', [8 * 60], null, 10, 0, WED)
  ok('monthly día 10 ya pasó → febrero', monthlyNext === Date.UTC(2026, 1, 10, 8, 0))

  // Zona horaria: Cuba = UTC-5 (invierno) → offset +300
  const cuba = sched.computeNextRun('daily', [9 * 60], null, null, 300, Date.UTC(2026, 0, 14, 10, 0))
  // En Cuba son las 05:00 del 14; hoy 09:00 local = 14:00 UTC
  ok('daily con tz Cuba (UTC-5)', cuba === Date.UTC(2026, 0, 14, 14, 0), `obtuvo ${cuba}`)

  // Intervalo puro: ahora + 90 min
  const intv = sched.computeNextRun('interval', null, null, null, 0, WED, 90)
  ok('interval cada 90 min', intv === WED + 90 * 60_000)
  // Intervalo con ventana: cae fuera (22:00 > 18:00) → mañana 09:00
  const intvWindow = sched.computeNextRun('interval', null, null, null, 0, Date.UTC(2026, 0, 14, 22, 0), 90, 9 * 60, 18 * 60)
  ok('interval fuera de ventana → mañana al abrir', intvWindow === Date.UTC(2026, 0, 15, 9, 0), `obtuvo ${intvWindow}`)
  // Intervalo antes del inicio de ventana → hoy al abrir
  const intvEarly = sched.computeNextRun('interval', null, null, null, 0, Date.UTC(2026, 0, 14, 6, 0), 90, 9 * 60, 18 * 60)
  ok('interval antes de ventana → hoy al abrir', intvEarly === Date.UTC(2026, 0, 14, 9, 0))

  // resolveNextRun validaciones nuevas
  const badIntv = sched.resolveNextRun({ sched_type: 'interval', interval_minutes: 0 })
  ok('intervalo 0 rechazado', !badIntv.ok)
  const badWindow = sched.resolveNextRun({ sched_type: 'interval', interval_minutes: 60, window_start: 600, window_end: 300 })
  ok('ventana invertida rechazada', !badWindow.ok)
  const halfWindow = sched.resolveNextRun({ sched_type: 'interval', interval_minutes: 60, window_start: 600 })
  ok('ventana incompleta rechazada', !halfWindow.ok)
  const okIntv = sched.resolveNextRun({ sched_type: 'interval', interval_minutes: 60 })
  ok('intervalo válido aceptado', okIntv.ok && (okIntv.next_run_at ?? 0) > Date.now())
  const noTimes = sched.resolveNextRun({ sched_type: 'daily', recur_times: [] })
  ok('daily sin horarios rechazada', !noTimes.ok)
  const manyTimes = sched.resolveNextRun({ sched_type: 'daily', recur_times: Array.from({ length: 25 }, (_, i) => i) })
  ok('daily con 25 horarios rechazada', !manyTimes.ok)

  const badPast = sched.resolveNextRun({ sched_type: 'once', scheduled_at: Date.now() - 1000 })
  ok('once en el pasado rechazada', !badPast.ok)
  const badSoon = sched.resolveNextRun({ sched_type: 'once', scheduled_at: Date.now() + 5000 })
  ok('once a <30s rechazada', !badSoon.ok)
  const goodOnce = sched.resolveNextRun({ sched_type: 'once', scheduled_at: Date.now() + 120_000 })
  ok('once futura aceptada', goodOnce.ok && goodOnce.next_run_at! > Date.now())
  const badDow = sched.resolveNextRun({ sched_type: 'weekly', recur_times: [600], recur_dow: 9 })
  ok('weekly con dow inválido rechazada', !badDow.ok)
  const badDom = sched.resolveNextRun({ sched_type: 'monthly', recur_times: [600], recur_dom: 31 })
  ok('monthly con dom 31 rechazada', !badDom.ok)

  /* ==================== 7. Scheduler con sendFn mock ================== */
  console.log('\n=== 7. Scheduler con envío simulado ===')
  const pub = await import('../lib/publishService.ts')
  const sentCalls: Array<{ accountId: number; jids: string[]; text: string; mediaId: number | null }> = []
  sched.startScheduler(async (accountId, jids, text, decorations, adminId, scheduleId, mediaId) => {
    sentCalls.push({ accountId, jids, text, mediaId: mediaId ?? null })
    // El mock cablea el mismo servicio real que usa index.ts: así el batch
    // queda registrado igual que en producción
    const r = await pub.executeAndLog({
      adminId, accountId, targetJids: jids, text,
      decorations: decorations ?? null, scheduleId, mediaId: mediaId ?? null
    })
    return { sent: r.sent, failed: r.failed }
  })
  sched.stopScheduler() // sólo queremos runDueSchedules manual

  // Schedule vencida de "una vez"
  const now = Date.now()
  const schedPast = db.insertSchedule({
    admin_id: adminId,
    name: 'Vencida una vez',
    sched_type: 'once',
    scheduled_at: now - 5000,
    recur_time: null, recur_times: null, recur_dow: null, recur_dom: null,
    interval_minutes: null, window_start: null, window_end: null,
    tz_offset_min: 0,
    next_run_at: now - 5000
  })
  db.insertScheduleMessage(schedPast, acc1, ['111@g.us'], 'mensaje vencido', JSON.stringify({ forwarded: true }))

  // Schedule recurrente vencida
  const dailySched = db.insertSchedule({
    admin_id: adminId,
    name: 'Diaria vencida',
    sched_type: 'daily',
    scheduled_at: null,
    recur_time: 8 * 60, recur_times: JSON.stringify([8 * 60]), recur_dow: null, recur_dom: null,
    interval_minutes: null, window_start: null, window_end: null,
    tz_offset_min: 0,
    next_run_at: now - 60_000
  })
  db.insertScheduleMessage(dailySched, acc2, ['444@g.us'], 'mensaje diario', null)

  const processed = await sched.runDueSchedules(now + 1000)
  ok('procesa las 2 vencidas', processed === 2, `procesó ${processed}`)
  ok('sendFn llamado 2 veces', sentCalls.length === 2)
  ok('envió por la cuenta correcta', sentCalls.some(c => c.accountId === acc1 && c.jids[0] === '111@g.us') && sentCalls.some(c => c.accountId === acc2))

  const pastRow = db.getSchedule(schedPast, adminId)
  ok('once vencida queda done', pastRow?.status === 'done' && pastRow?.last_run_at !== null)
  const dailyRow = db.getSchedule(dailySched, adminId)
  ok('daily reagendada a futuro', dailyRow?.status === 'active' && (dailyRow?.next_run_at ?? 0) > now, `next=${dailyRow?.next_run_at}`)
  ok('la schedule futura no se ejecutó', !sentCalls.some(c => c.text === 'Mensaje programado'))

  // Batch registrado con schedule_id para trazabilidad
  const batchWithSched = db.getRecentPublishBatches(50, adminId).find(b => b.schedule_id === schedPast)
  ok('batch del scheduler registrado con schedule_id', !!batchWithSched && batchWithSched.account_id === acc1)

  // Programación con duplicados + assign_map: la cuenta elegida envía.
  // Ambas cuentas con estado "connected" en DB: sin fallback de desconexión,
  // la elección del usuario se respeta tal cual.
  db.touchAccountConnected(acc2)
  const sentCallsAntes = sentCalls.length
  const schedAssign = db.insertSchedule({
    admin_id: adminId,
    name: 'Con duplicados y elección',
    sched_type: 'once',
    scheduled_at: now - 3000,
    recur_time: null, recur_times: null, recur_dow: null, recur_dom: null,
    interval_minutes: null, window_start: null, window_end: null,
    tz_offset_min: 0,
    next_run_at: now - 3000,
    assign_map: JSON.stringify({ '777@g.us': acc2 })
  })
  db.insertScheduleMessage(schedAssign, acc1, ['777@g.us', 'solo-a1@g.us'], 'msg a1', null)
  db.insertScheduleMessage(schedAssign, acc2, ['777@g.us', 'solo-a2@g.us'], 'msg a2', null)
  await sched.runDueSchedules(now + 2000)
  const nuevos = sentCalls.slice(sentCallsAntes)
  ok('scheduler: 777@g.us lo envía la cuenta elegida (acc2)', nuevos.some(c => c.accountId === acc2 && c.jids.includes('777@g.us')))
  ok('scheduler: acc1 conserva su destino propio', nuevos.some(c => c.accountId === acc1 && c.jids.includes('solo-a1@g.us')))
  ok('scheduler: acc1 NO envía el duplicado asignado a acc2', !nuevos.some(c => c.accountId === acc1 && c.jids.includes('777@g.us')))
  ok('scheduler: acc2 conserva su destino propio', nuevos.some(c => c.accountId === acc2 && c.jids.includes('solo-a2@g.us')))

  // Cuenta ELEGIDA desconectada al ejecutar: el destino viaja a otra
  // participante conectada que tenga ese destino (no se pierde en silencio).
  db.updateAccountStatus(acc2, 'disconnected')
  const sentCallsAntes2 = sentCalls.length
  const schedFallback = db.insertSchedule({
    admin_id: adminId,
    name: 'Elegida desconectada',
    sched_type: 'once',
    scheduled_at: now - 1000,
    recur_time: null, recur_times: null, recur_dow: null, recur_dom: null,
    interval_minutes: null, window_start: null, window_end: null,
    tz_offset_min: 0,
    next_run_at: now - 1000,
    assign_map: JSON.stringify({ '888@g.us': acc2 })
  })
  db.insertScheduleMessage(schedFallback, acc1, ['888@g.us'], 'msg fb a1', null)
  db.insertScheduleMessage(schedFallback, acc2, ['888@g.us'], 'msg fb a2', null)
  await sched.runDueSchedules(now + 3000)
  const nuevos2 = sentCalls.slice(sentCallsAntes2)
  ok('scheduler: elegida desconectada → fallback a acc1 (conectada)', nuevos2.some(c => c.accountId === acc1 && c.jids.includes('888@g.us')))
  ok('scheduler: acc2 (desconectada) no envía el duplicado', !nuevos2.some(c => c.accountId === acc2 && c.jids.includes('888@g.us')))
  db.touchAccountConnected(acc2)

  /* ============ 8. publishService con cuenta no conectada ============= */
  console.log('\n=== 8. publishService con cuenta desconectada ===')
  const resFail = await pub.executeAndLog({
    adminId, accountId: acc2, targetJids: ['444@g.us'], text: 'prueba', decorations: null
  })
  ok('cuenta sin socket → batch fallido completo', resFail.failed === 1 && resFail.sent === 0)
  ok('batch quedó en historial con estado failed', db.getRecentPublishBatches(50, adminId).some(b => b.id === resFail.batchId && b.status === 'failed'))

  /* ==================== 9. Panel web con sesiones ===================== */
  console.log('\n=== 9. Panel web: auth y aislamiento ===')
  const client = await import('../lib/client.ts')
  client.configureAuthRoot(TEST_AUTH)

  const web = await import('../web/server.ts')
  const { url } = await web.startWebServer({ host: '127.0.0.1', port: 4321 })

  const jar = { token: null as string | null }
  const call = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (jar.token) headers['Authorization'] = 'Bearer ' + jar.token
    const res = await fetch(url + path, { ...options, headers })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }

  let r = await call('/api/templates')
  ok('sin sesión → 401', r.status === 401)

  r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'no-existe' }) })
  ok('login mal → 401', r.status === 401)

  r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: creds!.password }) })
  ok('login bien → 200 con token', r.status === 200 && !!r.data.token)
  jar.token = r.data.token

  r = await call('/api/auth/status')
  ok('status devuelve al superadmin', r.status === 200 && r.data.admin.role === 'superadmin')

  // Content-Type enforcement
  const raw = await fetch(url + '/api/templates', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + jar.token },
    body: 'name=x&text=y'
  })
  ok('POST sin JSON → 415', raw.status === 415)

  // Cuentas del superadmin (no las de juan)
  r = await call('/api/accounts')
  ok('superadmin ve sólo SUS 2 cuentas', r.status === 200 && r.data.count === 2, `obtuvo ${r.data.count}`)

  // Grupos de una cuenta propia (default: todos, incluidos los de sólo miembro)
  r = await call(`/api/groups?account_id=${acc1}`)
  ok('grupos de cuenta 1 (todos, con flag is_admin)', r.status === 200 && r.data.count === 4, `obtuvo ${r.data.count}`)
  ok('grupo miembro incluido con is_admin false', r.data.groups.some((g: { jid: string; is_admin: boolean }) => g.jid === '333@g.us' && g.is_admin === false))
  const restricted = (r.data.groups || []).find((g: { jid: string }) => g.jid === '334@g.us')
  ok('grupo restringido llega con can_send false', !!restricted && restricted.can_send === false)
  const normalMember = (r.data.groups || []).find((g: { jid: string }) => g.jid === '333@g.us')
  ok('grupo miembro normal llega con can_send true', !!normalMember && normalMember.can_send === true)
  r = await call(`/api/groups?account_id=${acc1}&scope=admin`)
  ok('scope=admin excluye grupos de miembro', r.status === 200 && r.data.count === 2, `obtuvo ${r.data.count}`)

  // Grupos de cuenta ajena
  r = await call(`/api/groups?account_id=${accJuan}`)
  ok('cuenta ajena → 400', r.status === 400)

  // Plantillas CRUD por HTTP
  r = await call('/api/templates', { method: 'POST', body: JSON.stringify({ name: 'HTTP', text: 'texto http' }) })
  ok('POST plantilla', r.status === 200 && r.data.id > 0)
  const httpTplId = r.data.id
  r = await call('/api/templates')
  ok('GET plantillas del superadmin (2)', r.status === 200 && r.data.count === 2)
  r = await call(`/api/templates/${httpTplId}`, { method: 'PUT', body: JSON.stringify({ name: 'HTTP v2', text: 'texto 2' }) })
  ok('PUT plantilla', r.status === 200)
  r = await call(`/api/templates/${httpTplId}`, { method: 'DELETE' })
  ok('DELETE plantilla', r.status === 200)

  // POST /templates/:id/publish: validaciones de seguridad y dedupe
  r = await call('/api/templates', { method: 'POST', body: JSON.stringify({ name: 'Pub ya', text: 'texto publicable' }) })
  const pubTplId = r.data.id
  r = await call(`/api/templates/${pubTplId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: accJuan, target_jids: ['555@g.us'] }] })
  })
  ok('template publish con cuenta AJENA → 400 (IDOR tapado)', r.status === 400)
  r = await call(`/api/templates/${pubTplId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, target_jids: ['no-es-grupo'] }] })
  })
  ok('template publish con jid inválido → 400', r.status === 400)
  r = await call(`/api/templates/${pubTplId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, target_jids: ['111@g.us'] }, { account_id: acc1, target_jids: ['111@g.us'] }] })
  })
  ok('template publish con jid repetido en misma cuenta → 400', r.status === 400)
  r = await call(`/api/templates/${pubTplId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, target_jids: ['111@g.us'] }, { account_id: acc2, target_jids: ['111@g.us'] }], assign: { '111@g.us': acc2 } })
  })
  ok('template publish con duplicados + assign → 200, lo envía la elegida', r.status === 200 && r.data.skipped_total === 1 && r.data.skipped[0]?.kept_by === acc2)
  r = await call(`/api/templates/${pubTplId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, target_jids: ['111@g.us'] }], delay_ms: 999999 })
  })
  ok('template publish con delay_ms fuera de rango → 400', r.status === 400)

  // Multimedia: upload + servir + plantilla con media + aislamiento
  const mediaMod = await import('../lib/media.ts')
  mediaMod.configureMediaDir(TEST_MEDIA)
  const fakePng = Buffer.from('contenido-falso-de-imagen-para-test-1234567890')
  const b64 = fakePng.toString('base64')

  const savedLib = mediaMod.saveMediaFromBase64({ adminId, base64: b64, mimeType: 'image/png', fileName: 'lib.png' })
  ok('saveMediaFromBase64 guarda', savedLib.ok === true && (savedLib.ok ? savedLib.media.id > 0 : false))
  if (savedLib.ok) {
    const buf = mediaMod.readMediaBuffer(savedLib.media)
    ok('readMediaBuffer devuelve el contenido', buf.equals(fakePng))
  }
  const badMime = mediaMod.saveMediaFromBase64({ adminId, base64: b64, mimeType: 'application/x-raro', fileName: 'x' })
  ok('mime no soportado rechazado', badMime.ok === false)
  const badB64 = mediaMod.saveMediaFromBase64({ adminId, base64: 'abc!!!def@', mimeType: 'image/png', fileName: 'bad.png' })
  ok('base64 inválido rechazado (charset)', badB64.ok === false)
  const badB64Pad = mediaMod.saveMediaFromBase64({ adminId, base64: 'abcde', mimeType: 'image/png', fileName: 'bad2.png' })
  ok('base64 con padding inválido rechazado', badB64Pad.ok === false)
  // El límite subió a 50 MB en la fusión (estándar de la rama mobile-first)
  const tooBig = mediaMod.saveMediaFromBase64({ adminId, base64: Buffer.alloc(51 * 1024 * 1024).toString('base64'), mimeType: 'image/png', fileName: 'big.png' })
  ok('archivo de 51MB rechazado', tooBig.ok === false)

  r = await call('/api/media', { method: 'POST', body: JSON.stringify({ base64: b64, mime_type: 'image/png', file_name: 'http.png' }) })
  ok('POST /api/media → 200 con id', r.status === 200 && r.data.id > 0, JSON.stringify(r.data))
  const httpMediaId = r.data.id
  const rMediaBad = await call('/api/media', { method: 'POST', body: JSON.stringify({ base64: b64, mime_type: 'application/x-raro' }) })
  ok('POST /api/media mime inválido → 400', rMediaBad.status === 400)
  const fetchMedia = await fetch(url + `/api/media/${httpMediaId}`, { headers: { Authorization: 'Bearer ' + jar.token } })
  ok('GET /api/media/:id sirve los bytes', fetchMedia.status === 200 && fetchMedia.headers.get('content-type') === 'image/png' && Buffer.from(await fetchMedia.arrayBuffer()).equals(fakePng))

  r = await call('/api/templates', { method: 'POST', body: JSON.stringify({ name: 'Con media', text: 'mirá esta imagen', media_id: httpMediaId }) })
  ok('plantilla con multimedia → 200', r.status === 200 && r.data.id > 0)
  const tplMediaId = r.data.id
  r = await call('/api/templates')
  const tplWithMedia = (r.data.items || []).find((t: { id: number }) => t.id === tplMediaId)
  ok('GET plantillas incluye info de media', !!tplWithMedia && tplWithMedia.media && tplWithMedia.media.media_type === 'image')

  jar.token = tokenJuan2
  r = await call('/api/templates', { method: 'POST', body: JSON.stringify({ name: 'Robo', text: 'x', media_id: httpMediaId }) })
  ok('plantilla con media ajena → 400', r.status === 400)
  jar.token = tokenSuperadmin

  // Publicación con multimedia a cuenta desconectada: batch fallido con content_type image
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, text: '', target_jids: ['111@g.us'], media_id: httpMediaId }] })
  })
  ok('publish con multimedia → batch fallido (cuenta no conectada)', r.status === 200 && r.data.failed === 1)
  r = await call('/api/publish/history')
  ok('historial registra content_type image', (r.data.items || []).some((b: { content_type: string }) => b.content_type === 'image'))

  // Duplicado intra-cuenta en publish: rechazo explícito (antes se perdía en silencio)
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, text: 'a', target_jids: ['111@g.us'] }, { account_id: acc1, text: 'b', target_jids: ['111@g.us'] }] })
  })
  ok('publish con jid repetido en misma cuenta → 400', r.status === 400)
  // Demasiados destinos por item
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, text: 'flood', target_jids: Array.from({ length: 201 }, (_, i) => `g${i}@g.us`) }] })
  })
  ok('publish con >200 destinos → 400', r.status === 400)

  // La plantilla con media se borra → multimedia huérfana se limpia
  r = await call(`/api/templates/${tplMediaId}`, { method: 'DELETE' })
  ok('DELETE plantilla con media', r.status === 200)
  const goneMedia = await fetch(url + `/api/media/${httpMediaId}`, { headers: { Authorization: 'Bearer ' + jar.token } })
  ok('media huérfana eliminada junto a la plantilla', goneMedia.status === 404)

  // Programaciones por HTTP: cuenta ajena rechazada
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Mala', sched_type: 'once',
      scheduled_at: Date.now() + 600_000,
      tz_offset_min: 0,
      messages: [{ account_id: accJuan, target_jids: ['555@g.us'], text: 'x' }]
    })
  })
  ok('schedule con cuenta ajena → 400', r.status === 400)

  // Programación válida propia
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Buena', sched_type: 'daily',
      recur_time: 8 * 60, recur_dow: null, recur_dom: null,
      tz_offset_min: 0,
      messages: [{ account_id: acc1, target_jids: ['111@g.us'], text: 'buen dia' }]
    })
  })
  ok('schedule válida → 200 con next_run', r.status === 200 && r.data.next_run_at > 0)
  const httpSchedId = r.data.id

  // Duplicado intra-cuenta entre mensajes de una programación → 400
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Dup intra', sched_type: 'daily', recur_time: 9 * 60, tz_offset_min: 0,
      messages: [
        { account_id: acc1, target_jids: ['111@g.us'], text: 'uno' },
        { account_id: acc1, target_jids: ['111@g.us'], text: 'dos' }
      ]
    })
  })
  ok('schedule con jid repetido en misma cuenta → 400', r.status === 400)

  // Programación diaria con VARIOS horarios por día
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Multi horarios', sched_type: 'daily',
      recur_times: [8 * 60, 14 * 60 + 30, 20 * 60],
      tz_offset_min: 0,
      messages: [{ account_id: acc1, target_jids: ['111@g.us'], text: 'multi' }]
    })
  })
  ok('schedule multi-horario → 200', r.status === 200 && r.data.next_run_at > 0)
  const multiSchedId = r.data.id

  // Programación de intervalo con ventana horaria
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Cada 90 min', sched_type: 'interval',
      interval_minutes: 90, window_start: 9 * 60, window_end: 18 * 60,
      tz_offset_min: 0,
      messages: [{ account_id: acc1, target_jids: ['111@g.us'], text: 'interval' }]
    })
  })
  ok('schedule intervalo con ventana → 200', r.status === 200 && r.data.next_run_at > 0)
  const intervalSchedId = r.data.id

  // Intervalo inválido rechazado
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({ name: 'Intervalo malo', sched_type: 'interval', interval_minutes: 0, tz_offset_min: 0, messages: [{ account_id: acc1, target_jids: ['111@g.us'], text: 'x' }] })
  })
  ok('intervalo 0 → 400', r.status === 400)

  // La serialización devuelve recur_times como array
  r = await call('/api/schedules')
  const multiRow = (r.data.items || []).find((s: { id: number }) => s.id === multiSchedId)
  ok('GET schedules devuelve recur_times array', Array.isArray(multiRow?.recur_times) && multiRow.recur_times.length === 3)
  const intervalRow = (r.data.items || []).find((s: { id: number }) => s.id === intervalSchedId)
  ok('GET schedules devuelve intervalo y ventana', intervalRow?.interval_minutes === 90 && intervalRow?.window_start === 540 && intervalRow?.window_end === 1080)

  // Programación con duplicados + assign_map: se guarda y se serializa
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Con elección', sched_type: 'once',
      scheduled_at: Date.now() + 600_000, tz_offset_min: 0,
      messages: [
        { account_id: acc1, target_jids: ['888@g.us'], text: 'a' },
        { account_id: acc2, target_jids: ['888@g.us'], text: 'b' }
      ],
      assign_map: { '888@g.us': acc2 }
    })
  })
  ok('schedule con assign_map → 200', r.status === 200)
  const assignSchedId = r.data.id
  r = await call('/api/schedules')
  const assignRow = (r.data.items || []).find((s: { id: number }) => s.id === assignSchedId)
  ok('GET schedules devuelve assign_map', assignRow?.assign_map && assignRow.assign_map['888@g.us'] === acc2)

  // assign_map con jid no duplicado se normaliza a null
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Assign inútil', sched_type: 'once',
      scheduled_at: Date.now() + 600_000, tz_offset_min: 0,
      messages: [{ account_id: acc1, target_jids: ['889@g.us'], text: 'a' }],
      assign_map: { '889@g.us': acc1 }
    })
  })
  r = await call('/api/schedules')
  const uselessRow = (r.data.items || []).find((s: { id: number }) => s.name === 'Assign inútil')
  ok('assign_map sin duplicados reales → null', uselessRow?.assign_map === null)

  // Programación con jid inválido → 400
  r = await call('/api/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Jid malo', sched_type: 'once',
      scheduled_at: Date.now() + 600_000, tz_offset_min: 0,
      messages: [{ account_id: acc1, target_jids: ['javascript:alert(1)'], text: 'a' }]
    })
  })
  ok('schedule con jid inválido → 400', r.status === 400)

  // Limpieza de schedules de prueba
  await call(`/api/schedules/${assignSchedId}`, { method: 'DELETE' })

  r = await call('/api/schedules')
  // 9: Una vez, Diaria vencida, Vencida una vez, Con duplicados y elección,
  //    Elegida desconectada, Buena, Multi horarios, Cada 90 min, Assign inútil
  //    (Con elección fue borrada arriba)
  ok('GET schedules del superadmin', r.status === 200 && r.data.count === 9, `obtuvo ${r.data?.count}`)
  r = await call(`/api/schedules/${httpSchedId}/pause`, { method: 'POST' })
  ok('pausar schedule', r.status === 200 && db.getSchedule(httpSchedId, adminId)?.status === 'paused')
  r = await call(`/api/schedules/${httpSchedId}/resume`, { method: 'POST' })
  ok('reanudar schedule', r.status === 200 && db.getSchedule(httpSchedId, adminId)?.status === 'active')
  r = await call(`/api/schedules/${httpSchedId}`, { method: 'DELETE' })
  ok('eliminar schedule', r.status === 200)

  // Publish: validaciones
  r = await call('/api/publish', { method: 'POST', body: JSON.stringify({ items: [] }) })
  ok('publish sin items → 400', r.status === 400)
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, text: 'hola', target_jids: [] }] })
  })
  ok('publish sin destinos → 400', r.status === 400)
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: accJuan, text: 'hola', target_jids: ['555@g.us'] }] })
  })
  ok('publish a cuenta ajena → 400', r.status === 400)
  // Envío real a cuenta no conectada (batch fallido registrado, HTTP 200)
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, text: 'prueba http', target_jids: ['111@g.us'] }] })
  })
  ok('publish a cuenta desconectada → batches fallidos', r.status === 200 && r.data.failed === 1 && r.data.batches.length === 1)
  r = await call('/api/publish/history')
  ok('historial con batches del superadmin', r.status === 200 && r.data.count >= 2)
  const batchSuperId = r.data.items[0].id

  // Publicación con duplicados + assign: la elegida se queda el destino
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({
      items: [
        { account_id: acc1, text: 'dup', target_jids: ['222@g.us'] },
        { account_id: acc2, text: 'dup', target_jids: ['222@g.us'] }
      ],
      assign: { '222@g.us': acc2 }
    })
  })
  ok('publish con assign → la cuenta elegida conserva el destino', r.status === 200 && r.data.skipped_total === 1 && r.data.skipped[0].kept_by === acc2)
  ok('publish con assign → el omitido es la otra cuenta', r.data.skipped[0].account_id === acc1)

  // Assign inválido (cuenta ajena al envío) → fallback sin error
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ account_id: acc1, text: 'dup', target_jids: ['111@g.us'] }],
      assign: { '111@g.us': accJuan }
    })
  })
  ok('publish con assign inválido → se ignora sin error', r.status === 200)

  // Validaciones nuevas: jid con formato inválido
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, text: 'x', target_jids: ['no-es-un-jid'] }] })
  })
  ok('publish con jid inválido → 400', r.status === 400)

  // Validaciones nuevas: texto gigante
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, text: 'a'.repeat(65_001), target_jids: ['111@g.us'] }] })
  })
  ok('publish con texto >65k → 400', r.status === 400)

  // Decoraciones con claves arbitrarias → whitelist
  r = await call('/api/publish', {
    method: 'POST',
    body: JSON.stringify({ items: [{ account_id: acc1, text: 'x', target_jids: ['111@g.us'], decorations: { forwarded: true, hack: { deep: true } } }] })
  })
  ok('publish con decoraciones extrañas → 200 (saneadas)', r.status === 200)

  // IDOR: juan no puede ver los detalles del batch del superadmin
  jar.token = tokenJuan2
  r = await call(`/api/publish/history/${batchSuperId}`)
  ok('IDOR: batch ajeno → 404', r.status === 404)
  r = await call('/api/publish/history')
  ok('juan sólo ve batches propios en historial', r.status === 200 && (r.data.items || []).every((b: { id: number }) => b.id !== batchSuperId))
  jar.token = tokenSuperadmin
  r = await call(`/api/publish/history/${batchSuperId}`)
  ok('el dueño sí ve su batch → 200', r.status === 200)

  // Rutas de superadmin
  jar.token = tokenJuan2
  r = await call('/api/admins')
  ok('admins listado para admin normal → 403', r.status === 403)
  jar.token = tokenSuperadmin
  r = await call('/api/admins')
  ok('admins listado para superadmin → 200', r.status === 200 && r.data.count === 2)

  // Aislamiento de juan: no ve plantillas ni cuentas del superadmin
  jar.token = tokenJuan2
  r = await call('/api/templates')
  ok('juan no ve plantillas ajenas', r.status === 200 && r.data.count === 1)
  r = await call('/api/accounts')
  ok('juan sólo ve su cuenta', r.status === 200 && r.data.count === 1)

  // Logout invalida el token
  r = await call('/api/auth/logout', { method: 'POST' })
  ok('logout ok', r.status === 200)
  r = await call('/api/templates')
  ok('después de logout → 401', r.status === 401)

  // Rate limit de login (ÚLTIMO porque bloquea la IP por 15 min)
  let got429 = false
  for (let i = 0; i < 9; i++) {
    const res = await fetch(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'mal-' + i })
    })
    if (res.status === 429) { got429 = true; break }
  }
  ok('rate limit bloquea tras intentos fallidos', got429)

  await web.stopWebServer()

  /* ========================= Resumen ================================= */
  db.closeDatabase()
  console.log(`\n=== Resultado: ${passed} PASS, ${failed} FAIL ===`)
  if (failed > 0) {
    console.error('❌ Hay tests fallando.')
    process.exit(1)
  }
  console.log('✅ Todos los tests pasaron.')
}

main().catch(err => {
  console.error('Error fatal en tests:', err)
  process.exit(1)
})
