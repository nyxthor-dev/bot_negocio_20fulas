/**
 * Test de migración v3.0 → v3.1: la columna recur_times llega como ALTER
 * TABLE y las programaciones existentes con horario único quedan
 * convertidas a array de un elemento sin perder datos.
 */

import Database from 'better-sqlite3'
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TEST_DB = resolve(ROOT, 'data', 'test-times-mig.db')

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
  for (const p of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    if (existsSync(p)) rmSync(p)
  }

  console.log('\n=== 1. DB con esquema v3.0 (sin recur_times ni intervalo) ===')
  const raw = new Database(TEST_DB)
  raw.pragma('journal_mode = WAL')
  raw.exec(`
    CREATE TABLE admin_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      first_run INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE wa_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      last_connected_at INTEGER
    );
    CREATE TABLE groups_cache (
      account_id INTEGER NOT NULL,
      jid TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_owner INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (account_id, jid)
    );
    CREATE TABLE templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      decorations TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sched_type TEXT NOT NULL,
      scheduled_at INTEGER,
      recur_time INTEGER,
      recur_dow INTEGER,
      recur_dom INTEGER,
      tz_offset_min INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER
    );
    CREATE TABLE schedule_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      target_jids TEXT NOT NULL,
      text TEXT NOT NULL,
      decorations TEXT
    );
    CREATE TABLE publish_batch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      text TEXT,
      media_path TEXT,
      decorations TEXT,
      total_targets INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_id INTEGER,
      account_id INTEGER,
      schedule_id INTEGER
    );
    CREATE TABLE publish_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER,
      target_jid TEXT NOT NULL,
      content_type TEXT NOT NULL,
      text TEXT,
      media_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at INTEGER NOT NULL,
      error TEXT
    );
  `)
  raw.prepare("INSERT INTO admin_credentials (username, password_hash, role, created_at) VALUES ('admin', 'scrypt:x:y', 'superadmin', ?)").run(Date.now())
  raw.prepare("INSERT INTO wa_accounts (admin_id, label, phone, status, created_at) VALUES (1, 'Principal', '549111111111', 'connected', ?)").run(Date.now())
  raw.prepare("INSERT INTO groups_cache (account_id, jid, name, is_admin, is_owner, last_seen) VALUES (1, '111@g.us', 'Grupo viejo', 1, 0, ?)").run(Date.now())
  raw.prepare("INSERT INTO groups_cache (account_id, jid, name, is_admin, is_owner, last_seen) VALUES (1, '222@g.us', 'Miembro viejo', 0, 0, ?)").run(Date.now())
  raw.prepare('INSERT INTO schedules (admin_id, name, sched_type, recur_time, recur_dow, recur_dom, tz_offset_min, status, created_at, updated_at, next_run_at) VALUES (1, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?)')
    .run('Diaria vieja', 'daily', 540, 'active', Date.now() - 1000, Date.now() - 1000, Date.now() + 3600_000)
  raw.prepare("INSERT INTO schedules (admin_id, name, sched_type, scheduled_at, tz_offset_min, status, created_at, updated_at, next_run_at) VALUES (1, 'Puntual', 'once', ?, 0, 'done', ?, ?, NULL)")
    .run(Date.now(), Date.now(), Date.now())
  raw.close()

  console.log('\n=== 2. Abrir con el módulo actual (corre migraciones) ===')
  const db = await import('../lib/db.ts')
  db.openDatabase(TEST_DB)

  const cols = db._debugListColumns('schedules')
  ok('columna recur_times agregada', cols.includes('recur_times'))
  ok('columna interval_minutes agregada', cols.includes('interval_minutes'))
  ok('columna window_start agregada', cols.includes('window_start'))
  ok('columna window_end agregada', cols.includes('window_end'))
  ok('columna media_id en templates', db._debugListColumns('templates').includes('media_id'))
  ok('columna media_id en schedule_messages', db._debugListColumns('schedule_messages').includes('media_id'))
  ok('tabla media creada', db._debugListTables().includes('media'))

  const gcols = db._debugListColumns('groups_cache')
  ok('columna can_send agregada a groups_cache', gcols.includes('can_send'))
  const grupoViejo = db.getAllCachedGroups(1).find(g => g.jid === '111@g.us')
  ok('grupo admin existente queda can_send=1 tras migración', grupoViejo?.can_send === 1)
  db.upsertGroup({ account_id: 1, jid: '222@g.us', name: 'Miembro viejo', is_admin: 0, is_owner: 0, can_send: 0 })
  const miembroViejo = db.getAllCachedGroups(1).find(g => g.jid === '222@g.us')
  ok('can_send=0 persiste en el upsert nuevo', miembroViejo?.can_send === 0)
  const otraVez = db.getAllCachedGroups(1).find(g => g.jid === '222@g.us')
  ok('relectura consistente', otraVez?.can_send === 0)

  const scheds = db.listSchedules(1)
  const diaria = scheds.find(s => s.name === 'Diaria vieja')
  ok('schedule diaria conservada', !!diaria)
  ok('recur_times backfill desde recur_time', diaria?.recur_times === JSON.stringify([540]), `obtuvo ${diaria?.recur_times}`)
  ok('recur_time original intacto', diaria?.recur_time === 540)
  const puntual = scheds.find(s => s.name === 'Puntual')
  ok('schedule puntual intacta (recur_times null)', puntual?.recur_times === null || puntual?.recur_times === undefined)

  console.log('\n=== 3. parseTimes sobre datos migrados ===')
  const sched = await import('../lib/scheduler.ts')
  const times = sched.parseTimes(diaria?.recur_times ?? null, diaria?.recur_time ?? null)
  ok('parseTimes resuelve el array migrado', times.length === 1 && times[0] === 540)
  const next = sched.computeNextRun('daily', times, null, null, 0)
  ok('computeNextRun funciona con datos migrados', next !== null && next > Date.now())

  db.closeDatabase()
  for (const p of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    if (existsSync(p)) rmSync(p)
  }

  console.log(`\n=== Resultado: ${passed} PASS, ${failed} FAIL ===`)
  if (failed === 0) {
    console.log('✅ Migración de horarios v3.0 → v3.1 verificada.')
    process.exit(0)
  }
  process.exit(1)
}

main().catch(err => {
  console.error('Error fatal en tests:', err)
  process.exit(1)
})
