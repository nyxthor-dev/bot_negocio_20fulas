/**
 * Test de migración: simula una DB de la v2.x (mono-cuenta, sin roles) y
 * verifica que openDatabase() la migra a el esquema v3 sin perder datos.
 */

import Database from 'better-sqlite3'
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = resolve(__dirname, '..', 'data', 'test-migration.db')

let passed = 0
let failed = 0
function ok (name, cond, extra = '') {
  if (cond) { passed++; console.log(`  [PASS] ${name}`) }
  else { failed++; console.error(`  [FAIL] ${name} ${extra}`) }
}

// 1. Crear una DB con el esquema viejo de la v2.x, con datos dentro
for (const p of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  if (existsSync(p)) rmSync(p)
}

const legacy = new Database(TEST_DB)
legacy.pragma('journal_mode = WAL')
legacy.exec(`
  CREATE TABLE admin_credentials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    UNIQUE NOT NULL,
    password_hash   TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    first_run       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE publish_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id        INTEGER,
    target_jid      TEXT    NOT NULL,
    content_type    TEXT    NOT NULL,
    text            TEXT,
    media_path      TEXT,
    status          TEXT    NOT NULL DEFAULT 'pending',
    sent_at         INTEGER NOT NULL,
    error           TEXT
  );

  CREATE TABLE groups_cache (
    jid             TEXT PRIMARY KEY,
    name            TEXT NOT NULL DEFAULT '',
    is_admin        INTEGER NOT NULL DEFAULT 0,
    is_owner        INTEGER NOT NULL DEFAULT 0,
    last_seen       INTEGER NOT NULL
  );
`)
legacy.prepare(`INSERT INTO admin_credentials (username, password_hash, created_at, first_run) VALUES (?, ?, ?, ?)`)
  .run('admin', 'scrypt:aabb:ccdd', Date.now() - 86400000, Date.now() - 86400000)
legacy.prepare(`INSERT INTO groups_cache (jid, name, is_admin, is_owner, last_seen) VALUES (?, ?, 1, 0, ?)`)
  .run('123456@g.us', 'Grupo viejo', Date.now())
legacy.close()
console.log('DB v2 simulada creada con datos.')

// 2. Abrir con el esquema nuevo (dispara las migraciones)
const db = await import('../lib/db.ts')
db.openDatabase(TEST_DB)

console.log('\n=== Migración v2 → v3 ===')

const adminCols = db._debugListColumns('admin_credentials')
ok('admin_credentials gana columna role', adminCols.includes('role'))
ok('admin_credentials gana columna disabled', adminCols.includes('disabled'))

const admin = db.getAdminCredentials()
ok('admin v2 conservado', admin?.username === 'admin' && admin?.password_hash === 'scrypt:aabb:ccdd')
ok('admin v2 promovido a superadmin', admin?.role === 'superadmin')
ok('admin v2 sigue habilitado', admin?.disabled === 0)

const groupCols = db._debugListColumns('groups_cache')
ok('groups_cache recreada multi-cuenta', groupCols.includes('account_id'))
ok('caché vieja regenerable descartada', !db.getAllCachedGroups(1).some(g => g.jid === '123456@g.us'))

const batchCols = db._debugListColumns('publish_batch')
ok('publish_batch gana admin_id/account_id/schedule_id',
  batchCols.includes('admin_id') && batchCols.includes('account_id') && batchCols.includes('schedule_id'))

for (const t of ['auth_sessions', 'wa_accounts', 'templates', 'schedules', 'schedule_messages', 'publish_batch']) {
  ok(`tabla nueva ${t} creada`, db._debugListTables().includes(t))
}

// 3. Re-abrir (idempotencia: migrar dos veces no rompe nada)
db.closeDatabase()
db.openDatabase(TEST_DB)
ok('re-migración idempotente', db.getAdminCredentials()?.role === 'superadmin')

db.closeDatabase()
console.log(`\n=== Resultado: ${passed} PASS, ${failed} FAIL ===`)
if (failed > 0) {
  console.error('❌ Hay tests fallando.')
  process.exit(1)
}
console.log('✅ Migración v2 → v3 verificada.')
