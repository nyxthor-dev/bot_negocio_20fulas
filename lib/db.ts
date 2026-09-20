import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.ts'

const log = logger('db')

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = resolve(__dirname, '..', 'data', 'bot.db')

export type AdminRole = 'superadmin' | 'admin'

export interface AdminRow {
  id: number
  username: string
  password_hash: string
  role: AdminRole
  disabled: number
  created_at: number
  first_run: number
}

export interface SessionRow {
  token_hash: string
  admin_id: number
  created_at: number
  expires_at: number
  admin?: AdminRow
}

/** Una cuenta WhatsApp vinculada por un admin. Cada una tiene su sesión propia. */
export interface WaAccountRow {
  id: number
  admin_id: number
  label: string
  phone: string
  status: 'pending' | 'linking' | 'connected' | 'disconnected' | 'logged_out'
  created_at: number
  last_connected_at: number | null
}

export interface GroupCacheRow {
  account_id: number
  jid: string
  name: string
  is_admin: number
  is_owner: number
  can_send: number
  last_seen: number
}

/** Archivo multimedia guardado en disco (imagen/video/audio/documento). */
export interface MediaRow {
  id: number
  admin_id: number
  file_name: string
  mime_type: string
  media_type: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  size: number
  storage_path: string
  created_at: number
}

/** Plantilla guardada para reciclar publicaciones sin reescribirlas. */
export interface TemplateRow {
  id: number
  admin_id: number
  name: string
  text: string
  decorations: string | null
  media_id: number | null
  created_at: number
  updated_at: number
}

export type ScheduleType = 'once' | 'daily' | 'weekly' | 'monthly' | 'interval'
export type ScheduleStatus = 'active' | 'paused' | 'done'

export interface ScheduleRow {
  id: number
  admin_id: number
  name: string
  sched_type: ScheduleType
  scheduled_at: number | null
  recur_time: number | null
  recur_times: string | null
  recur_dow: number | null
  recur_dom: number | null
  interval_minutes: number | null
  window_start: number | null
  window_end: number | null
  tz_offset_min: number
  status: ScheduleStatus
  created_at: number
  updated_at: number
  last_run_at: number | null
  next_run_at: number | null
  /** JSON { jid → accountId }: cuenta elegida por el usuario para destinos duplicados. */
  assign_map: string | null
}

/** Mensaje individual dentro de una programación: cuenta + destinos + texto/multimedia. */
export interface ScheduleMessageRow {
  id: number
  schedule_id: number
  account_id: number
  target_jids: string    // JSON array serializado
  text: string
  decorations: string | null
  media_id: number | null
}

/**
 * Una publicación batch (un envío a múltiples destinos = 1 registro).
 * El historial del panel muestra estas, no los destinos individuales.
 */
export interface PublishBatchRow {
  id: number
  sent_at: number
  content_type: string
  text: string | null
  media_path: string | null
  decorations: string | null
  total_targets: number
  sent_count: number
  failed_count: number
  status: 'sent' | 'partial' | 'failed'
  admin_id: number | null
  account_id: number | null
  schedule_id: number | null
}

export interface PublishLogRow {
  id: number
  batch_id: number | null
  target_jid: string
  content_type: string
  text: string | null
  media_path: string | null
  status: 'pending' | 'sent' | 'failed'
  sent_at: number
  error: string | null
}

let db: Database.Database | null = null

/**
 * Abre (o crea) la base de datos SQLite y crea las tablas si no existen.
 * Hace migraciones idempotentes (ALTER TABLE para columnas nuevas).
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (db) return db

  mkdirSync(dirname(dbPath), { recursive: true })

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  createSchema(db)
  migrateSchema(db)
  // Índices post-migración: groups_cache puede haber sido recreada recién y
  // publish_batch puede haber recibido la columna admin_id por migración.
  db.exec('CREATE INDEX IF NOT EXISTS idx_groups_cache_admin ON groups_cache(account_id, is_admin)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_publish_batch_admin ON publish_batch(admin_id)')
  log.info(`SQLite abierto: ${dbPath}`)

  return db
}

function createSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS admin_credentials (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT    UNIQUE NOT NULL,
      password_hash   TEXT    NOT NULL,
      role            TEXT    NOT NULL DEFAULT 'admin',
      disabled        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      first_run       INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash  TEXT    PRIMARY KEY,
      admin_id    INTEGER NOT NULL REFERENCES admin_credentials(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_admin ON auth_sessions(admin_id);

    CREATE TABLE IF NOT EXISTS wa_accounts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id           INTEGER NOT NULL REFERENCES admin_credentials(id) ON DELETE CASCADE,
      label              TEXT    NOT NULL,
      phone              TEXT    NOT NULL DEFAULT '',
      status             TEXT    NOT NULL DEFAULT 'pending',
      created_at         INTEGER NOT NULL,
      last_connected_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wa_accounts_admin ON wa_accounts(admin_id);

    -- Caché de grupos/canales POR CUENTA (cada cuenta ve grupos distintos)
    CREATE TABLE IF NOT EXISTS groups_cache (
      account_id  INTEGER NOT NULL,
      jid         TEXT    NOT NULL,
      name        TEXT    NOT NULL DEFAULT '',
      is_admin    INTEGER NOT NULL DEFAULT 0,
      is_owner    INTEGER NOT NULL DEFAULT 0,
      can_send    INTEGER NOT NULL DEFAULT 1,
      last_seen   INTEGER NOT NULL,
      PRIMARY KEY (account_id, jid)
    );

    CREATE TABLE IF NOT EXISTS templates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id     INTEGER NOT NULL REFERENCES admin_credentials(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      text         TEXT    NOT NULL,
      decorations  TEXT,
      media_id     INTEGER,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_templates_admin ON templates(admin_id);

    -- Archivos multimedia subidos desde el panel (guardados en data/media/)
    CREATE TABLE IF NOT EXISTS media (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id     INTEGER NOT NULL REFERENCES admin_credentials(id) ON DELETE CASCADE,
      file_name    TEXT    NOT NULL DEFAULT '',
      mime_type    TEXT    NOT NULL DEFAULT '',
      media_type   TEXT    NOT NULL,
      size         INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT    NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_admin ON media(admin_id);

    CREATE TABLE IF NOT EXISTS schedules (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id         INTEGER NOT NULL REFERENCES admin_credentials(id) ON DELETE CASCADE,
      name             TEXT    NOT NULL,
      sched_type       TEXT    NOT NULL,
      scheduled_at     INTEGER,
      recur_time       INTEGER,
      recur_times      TEXT,
      recur_dow        INTEGER,
      recur_dom        INTEGER,
      interval_minutes INTEGER,
      window_start     INTEGER,
      window_end       INTEGER,
      tz_offset_min    INTEGER NOT NULL DEFAULT 0,
      status           TEXT    NOT NULL DEFAULT 'active',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      last_run_at      INTEGER,
      next_run_at      INTEGER,
      assign_map       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, next_run_at);

    CREATE TABLE IF NOT EXISTS schedule_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id  INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      account_id   INTEGER NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
      target_jids  TEXT    NOT NULL,
      text         TEXT    NOT NULL,
      decorations  TEXT,
      media_id     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_messages_sched ON schedule_messages(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_messages_account ON schedule_messages(account_id);

    -- Tabla de batches: 1 registro por publicación (envío a múltiples destinos)
    CREATE TABLE IF NOT EXISTS publish_batch (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at         INTEGER NOT NULL,
      content_type    TEXT    NOT NULL,
      text            TEXT,
      media_path      TEXT,
      decorations     TEXT,
      total_targets   INTEGER NOT NULL DEFAULT 0,
      sent_count      INTEGER NOT NULL DEFAULT 0,
      failed_count    INTEGER NOT NULL DEFAULT 0,
      status          TEXT    NOT NULL DEFAULT 'pending',
      admin_id        INTEGER,
      account_id      INTEGER,
      schedule_id     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_publish_batch_sent_at ON publish_batch(sent_at DESC);
    -- NOTA: idx_publish_batch_admin se crea en openDatabase DESPUÉS de
    -- migrateSchema, porque la columna admin_id la agrega la migración v2→v3.

    CREATE TABLE IF NOT EXISTS publish_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id        INTEGER,
      target_jid      TEXT    NOT NULL,
      content_type    TEXT    NOT NULL,
      text            TEXT,
      media_path      TEXT,
      status          TEXT    NOT NULL DEFAULT 'pending',
      sent_at         INTEGER NOT NULL,
      error           TEXT,
      FOREIGN KEY (batch_id) REFERENCES publish_batch(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_publish_log_sent_at ON publish_log(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_publish_log_batch_id ON publish_log(batch_id);
  `)
}

/**
 * Migraciones idempotentes: si la DB ya existe con esquema viejo (v2.x),
 * agregamos las columnas/tablas nuevas sin perder datos.
 */
function migrateSchema(d: Database.Database): void {
  // 1. admin_credentials: columnas role + disabled (v2.x no las tenía)
  const adminCols = d.prepare('PRAGMA table_info(admin_credentials)').all() as { name: string }[]
  if (!adminCols.some(c => c.name === 'role')) {
    d.exec("ALTER TABLE admin_credentials ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'")
    log.info('Migración: agregada columna role a admin_credentials.')
  }
  if (!adminCols.some(c => c.name === 'disabled')) {
    d.exec('ALTER TABLE admin_credentials ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0')
    log.info('Migración: agregada columna disabled a admin_credentials.')
  }
  // El admin existente de la v2 pasa a ser superadmin
  const superCount = d.prepare("SELECT COUNT(*) AS n FROM admin_credentials WHERE role = 'superadmin'").get() as { n: number }
  if (superCount.n === 0) {
    const total = d.prepare('SELECT COUNT(*) AS n FROM admin_credentials').get() as { n: number }
    if (total.n > 0) {
      d.prepare("UPDATE admin_credentials SET role = 'superadmin' WHERE id = (SELECT MIN(id) FROM admin_credentials)").run()
      log.info('Migración: admin existente promovido a superadmin.')
    }
  }

  // 2. groups_cache: se volvió multi-cuenta. Es caché regenerable → se recrea.
  const groupCols = d.prepare('PRAGMA table_info(groups_cache)').all() as { name: string }[]
  if (groupCols.length > 0 && !groupCols.some(c => c.name === 'account_id')) {
    d.exec('DROP TABLE groups_cache')
    d.exec(`
      CREATE TABLE groups_cache (
        account_id  INTEGER NOT NULL,
        jid         TEXT    NOT NULL,
        name        TEXT    NOT NULL DEFAULT '',
        is_admin    INTEGER NOT NULL DEFAULT 0,
        is_owner    INTEGER NOT NULL DEFAULT 0,
        can_send    INTEGER NOT NULL DEFAULT 1,
        last_seen   INTEGER NOT NULL,
        PRIMARY KEY (account_id, jid)
      )
    `)
    log.warn('Migración: groups_cache era del esquema mono-cuenta, se recreó vacía (es caché, se resincroniza sola).')
  }

  // 2b. groups_cache: flag de permiso de escritura (grupos donde sólo escriben
  // los admins y la cuenta es miembro). Los rows viejos arrancan en 1 y se
  // corrigen solos en la próxima sincronización.
  const groupCols2 = d.prepare('PRAGMA table_info(groups_cache)').all() as { name: string }[]
  if (groupCols2.length > 0 && !groupCols2.some(c => c.name === 'can_send')) {
    d.exec('ALTER TABLE groups_cache ADD COLUMN can_send INTEGER NOT NULL DEFAULT 1')
    log.info('Migración: agregada columna can_send a groups_cache.')
  }

  // 3. publish_batch: columnas admin_id / account_id / schedule_id
  const batchCols = d.prepare('PRAGMA table_info(publish_batch)').all() as { name: string }[]
  if (!batchCols.some(c => c.name === 'admin_id')) {
    d.exec('ALTER TABLE publish_batch ADD COLUMN admin_id INTEGER')
    log.info('Migración: agregada columna admin_id a publish_batch.')
  }
  if (!batchCols.some(c => c.name === 'account_id')) {
    d.exec('ALTER TABLE publish_batch ADD COLUMN account_id INTEGER')
    log.info('Migración: agregada columna account_id a publish_batch.')
  }
  if (!batchCols.some(c => c.name === 'schedule_id')) {
    d.exec('ALTER TABLE publish_batch ADD COLUMN schedule_id INTEGER')
    log.info('Migración: agregada columna schedule_id a publish_batch.')
  }

  // 4. multimedia: tabla media + referencias en plantillas y mensajes programados
  const tmplCols = d.prepare('PRAGMA table_info(templates)').all() as { name: string }[]
  if (tmplCols.length > 0 && !tmplCols.some(c => c.name === 'media_id')) {
    d.exec('ALTER TABLE templates ADD COLUMN media_id INTEGER')
    log.info('Migración: agregada columna media_id a templates.')
  }
  const smCols = d.prepare('PRAGMA table_info(schedule_messages)').all() as { name: string }[]
  if (smCols.length > 0 && !smCols.some(c => c.name === 'media_id')) {
    d.exec('ALTER TABLE schedule_messages ADD COLUMN media_id INTEGER')
    log.info('Migración: agregada columna media_id a schedule_messages.')
  }

  // 5. schedules: multi-horario por día (recur_times) + modo intervalo con ventana
  const schedCols = d.prepare('PRAGMA table_info(schedules)').all() as { name: string }[]
  if (schedCols.length > 0) {
    if (!schedCols.some(c => c.name === 'recur_times')) {
      d.exec('ALTER TABLE schedules ADD COLUMN recur_times TEXT')
      log.info('Migración: agregada columna recur_times a schedules.')
    }
    if (!schedCols.some(c => c.name === 'interval_minutes')) {
      d.exec('ALTER TABLE schedules ADD COLUMN interval_minutes INTEGER')
      log.info('Migración: agregada columna interval_minutes a schedules.')
    }
    if (!schedCols.some(c => c.name === 'window_start')) {
      d.exec('ALTER TABLE schedules ADD COLUMN window_start INTEGER')
      log.info('Migración: agregada columna window_start a schedules.')
    }
    if (!schedCols.some(c => c.name === 'window_end')) {
      d.exec('ALTER TABLE schedules ADD COLUMN window_end INTEGER')
      log.info('Migración: agregada columna window_end a schedules.')
    }
    if (!schedCols.some(c => c.name === 'assign_map')) {
      d.exec('ALTER TABLE schedules ADD COLUMN assign_map TEXT')
      log.info('Migración: agregada columna assign_map a schedules.')
    }
    // Horario único viejo -> array de un elemento
    d.prepare("UPDATE schedules SET recur_times = '[' || recur_time || ']' WHERE recur_times IS NULL AND recur_time IS NOT NULL").run()
  }
}

/* ---------- admin_credentials ---------- */

/** Devuelve el primer admin (compat con el bootstrap de primera ejecución). */
export function getAdminCredentials(): AdminRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM admin_credentials ORDER BY id ASC LIMIT 1').get() as AdminRow | undefined
}

export function getAdminByUsername(username: string): AdminRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM admin_credentials WHERE username = ?').get(username) as AdminRow | undefined
}

export function getAdminById(id: number): AdminRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM admin_credentials WHERE id = ?').get(id) as AdminRow | undefined
}

export function listAdmins(): AdminRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM admin_credentials ORDER BY id ASC').all() as AdminRow[]
}

export function insertAdminCredentials(
  username: string,
  passwordHash: string,
  role: AdminRole = 'admin',
  createdAt: number = Date.now()
): number {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare(`
    INSERT INTO admin_credentials (username, password_hash, role, disabled, created_at, first_run)
    VALUES (@username, @passwordHash, @role, 0, @createdAt, @createdAt)
  `).run({ username, passwordHash, role, createdAt })
  return Number(result.lastInsertRowid)
}

export function updateAdminPassword(username: string, passwordHash: string): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('UPDATE admin_credentials SET password_hash = ? WHERE username = ?')
    .run(passwordHash, username)
}

export function setAdminDisabled(id: number, disabled: boolean): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('UPDATE admin_credentials SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id)
}

export function deleteAdmin(id: number): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('DELETE FROM admin_credentials WHERE id = ?').run(id)
}

/* ---------- auth_sessions ---------- */

export function createSession(tokenHash: string, adminId: number, expiresAt: number): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare(`
    INSERT INTO auth_sessions (token_hash, admin_id, created_at, expires_at)
    VALUES (@tokenHash, @adminId, @createdAt, @expiresAt)
  `).run({ tokenHash, adminId, createdAt: Date.now(), expiresAt })
}

/** Busca la sesión por hash de token y la devuelve junto al admin (si sigue vigente). */
export function getSessionByTokenHash(tokenHash: string): SessionRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare(`
    SELECT s.*, a.id AS a_id, a.username, a.password_hash, a.role, a.disabled, a.created_at, a.first_run
    FROM auth_sessions s
    JOIN admin_credentials a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled = 0
  `).get(tokenHash, Date.now()) as unknown as SessionRow | undefined
}

export function deleteSession(tokenHash: string): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash)
}

export function deleteSessionsForAdmin(adminId: number): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('DELETE FROM auth_sessions WHERE admin_id = ?').run(adminId)
}

/** Limpieza de sesiones vencidas. Devuelve cuántas borró. */
export function cleanExpiredSessions(): number {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now())
  return result.changes
}

/* ---------- wa_accounts ---------- */

export function insertAccount(adminId: number, label: string, phone: string): number {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare(`
    INSERT INTO wa_accounts (admin_id, label, phone, status, created_at)
    VALUES (@adminId, @label, @phone, 'pending', @createdAt)
  `).run({ adminId, label, phone, createdAt: Date.now() })
  return Number(result.lastInsertRowid)
}

export function getAccount(id: number): WaAccountRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM wa_accounts WHERE id = ?').get(id) as WaAccountRow | undefined
}

export function listAccounts(adminId?: number): WaAccountRow[] {
  if (!db) throw new Error('DB no abierta.')
  if (adminId === undefined) {
    return db.prepare('SELECT * FROM wa_accounts ORDER BY id ASC').all() as WaAccountRow[]
  }
  return db.prepare('SELECT * FROM wa_accounts WHERE admin_id = ? ORDER BY id ASC').all(adminId) as WaAccountRow[]
}

export function updateAccountStatus(id: number, status: WaAccountRow['status']): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('UPDATE wa_accounts SET status = ? WHERE id = ?').run(status, id)
}

export function touchAccountConnected(id: number): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare("UPDATE wa_accounts SET status = 'connected', last_connected_at = ? WHERE id = ?")
    .run(Date.now(), id)
}

export function deleteAccount(id: number): void {
  if (!db) throw new Error('DB no abierta.')
  // Transacción: o se borra todo del account o nada (sin schedule_messages
  // huérfanas ni groups_cache zombie).
  db.transaction(() => {
    db!.prepare('DELETE FROM groups_cache WHERE account_id = ?').run(id)
    db!.prepare('DELETE FROM schedule_messages WHERE account_id = ?').run(id)
    db!.prepare('DELETE FROM wa_accounts WHERE id = ?').run(id)
  })()
  // Al quedarse sin mensajes, una programación recurrente se ejecutaría
  // vacía en cada vencimiento para siempre: se da de baja.
  db.prepare(`
    UPDATE schedules SET status = 'done', updated_at = ?
    WHERE status = 'active' AND id NOT IN (SELECT DISTINCT schedule_id FROM schedule_messages)
  `).run(Date.now())
}

/* ---------- groups_cache ---------- */

export function upsertGroup(row: Omit<GroupCacheRow, 'last_seen'> & { last_seen?: number }): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare(`
    INSERT INTO groups_cache (account_id, jid, name, is_admin, is_owner, can_send, last_seen)
    VALUES (@account_id, @jid, @name, @is_admin, @is_owner, @can_send, @last_seen)
    ON CONFLICT(account_id, jid) DO UPDATE SET
      name      = excluded.name,
      is_admin  = excluded.is_admin,
      is_owner  = excluded.is_owner,
      can_send  = excluded.can_send,
      last_seen = excluded.last_seen
  `).run({
    account_id: row.account_id,
    jid: row.jid,
    name: row.name,
    is_admin: row.is_admin,
    is_owner: row.is_owner,
    can_send: row.can_send,
    last_seen: row.last_seen ?? Date.now()
  })
}

/** Grupos/canales donde la cuenta dada es admin (cache SQL). */
export function getAdminGroups(accountId: number): GroupCacheRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare(`
    SELECT * FROM groups_cache
    WHERE account_id = ? AND is_admin = 1
    ORDER BY name COLLATE NOCASE ASC
  `).all(accountId) as GroupCacheRow[]
}

export function getAllCachedGroups(accountId: number): GroupCacheRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare(`
    SELECT * FROM groups_cache WHERE account_id = ? ORDER BY name COLLATE NOCASE ASC
  `).all(accountId) as GroupCacheRow[]
}

export function countAdminGroups(accountId: number): number {
  if (!db) throw new Error('DB no abierta.')
  const row = db.prepare('SELECT COUNT(*) AS n FROM groups_cache WHERE account_id = ? AND is_admin = 1')
    .get(accountId) as { n: number }
  return row.n
}

/* ---------- media ---------- */

export function insertMedia(row: Omit<MediaRow, 'id'>): number {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare(`
    INSERT INTO media (admin_id, file_name, mime_type, media_type, size, storage_path, created_at)
    VALUES (@admin_id, @file_name, @mime_type, @media_type, @size, @storage_path, @created_at)
  `).run(row)
  return Number(result.lastInsertRowid)
}

export function getMediaById(id: number): MediaRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined
}

export function getMediaByIdAndAdmin(id: number, adminId: number): MediaRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM media WHERE id = ? AND admin_id = ?').get(id, adminId) as MediaRow | undefined
}

export function deleteMediaRow(id: number): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('DELETE FROM media WHERE id = ?').run(id)
}

/** ¿Alguna plantilla o mensaje programado sigue usando este archivo? */
export function countMediaReferences(mediaId: number): number {
  if (!db) throw new Error('DB no abierta.')
  const t = db.prepare('SELECT COUNT(*) AS n FROM templates WHERE media_id = ?').get(mediaId) as { n: number }
  const s = db.prepare('SELECT COUNT(*) AS n FROM schedule_messages WHERE media_id = ?').get(mediaId) as { n: number }
  return t.n + s.n
}

/* ---------- templates ---------- */

export function insertTemplate(adminId: number, name: string, text: string, decorations: string | null, mediaId: number | null = null): number {
  if (!db) throw new Error('DB no abierta.')
  const now = Date.now()
  const result = db.prepare(`
    INSERT INTO templates (admin_id, name, text, decorations, media_id, created_at, updated_at)
    VALUES (@adminId, @name, @text, @decorations, @mediaId, @now, @now)
  `).run({ adminId, name, text, decorations, mediaId, now })
  return Number(result.lastInsertRowid)
}

export function updateTemplate(id: number, adminId: number, name: string, text: string, decorations: string | null, mediaId: number | null = null): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare(`
    UPDATE templates SET name = @name, text = @text, decorations = @decorations, media_id = @mediaId, updated_at = @now
    WHERE id = @id AND admin_id = @adminId
  `).run({ id, adminId, name, text, decorations, mediaId, now: Date.now() })
}

export function deleteTemplate(id: number, adminId: number): boolean {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare('DELETE FROM templates WHERE id = ? AND admin_id = ?').run(id, adminId)
  return result.changes > 0
}

export function getTemplate(id: number, adminId: number): TemplateRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM templates WHERE id = ? AND admin_id = ?')
    .get(id, adminId) as TemplateRow | undefined
}

export function listTemplates(adminId: number): TemplateRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM templates WHERE admin_id = ? ORDER BY updated_at DESC')
    .all(adminId) as TemplateRow[]
}

/* ---------- schedules + schedule_messages ---------- */

export interface ScheduleInsert {
  admin_id: number
  name: string
  sched_type: ScheduleType
  scheduled_at: number | null
  recur_time: number | null
  recur_times: string | null
  recur_dow: number | null
  recur_dom: number | null
  interval_minutes: number | null
  window_start: number | null
  window_end: number | null
  tz_offset_min: number
  next_run_at: number | null
  assign_map?: string | null
}

export function insertSchedule(s: ScheduleInsert): number {
  if (!db) throw new Error('DB no abierta.')
  const now = Date.now()
  const result = db.prepare(`
    INSERT INTO schedules (admin_id, name, sched_type, scheduled_at, recur_time, recur_times, recur_dow, recur_dom, interval_minutes, window_start, window_end, tz_offset_min, status, created_at, updated_at, next_run_at, assign_map)
    VALUES (@admin_id, @name, @sched_type, @scheduled_at, @recur_time, @recur_times, @recur_dow, @recur_dom, @interval_minutes, @window_start, @window_end, @tz_offset_min, 'active', @now, @now, @next_run_at, @assign_map)
  `).run({ assign_map: null, ...s, now })
  return Number(result.lastInsertRowid)
}

export interface ScheduleUpdate {
  name: string
  sched_type: ScheduleType
  scheduled_at: number | null
  recur_time: number | null
  recur_times: string | null
  recur_dow: number | null
  recur_dom: number | null
  interval_minutes: number | null
  window_start: number | null
  window_end: number | null
  tz_offset_min: number
  status: ScheduleStatus
  next_run_at: number | null
  assign_map?: string | null
}

export function updateSchedule(id: number, adminId: number, u: ScheduleUpdate): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare(`
    UPDATE schedules SET
      name = @name, sched_type = @sched_type, scheduled_at = @scheduled_at,
      recur_time = @recur_time, recur_times = @recur_times, recur_dow = @recur_dow, recur_dom = @recur_dom,
      interval_minutes = @interval_minutes, window_start = @window_start, window_end = @window_end,
      tz_offset_min = @tz_offset_min, status = @status, next_run_at = @next_run_at,
      assign_map = @assign_map,
      updated_at = @now
    WHERE id = @id AND admin_id = @adminId
  `).run({ assign_map: null, ...u, id, adminId, now: Date.now() })
}

export function deleteSchedule(id: number, adminId: number): boolean {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare('DELETE FROM schedules WHERE id = ? AND admin_id = ?').run(id, adminId)
  return result.changes > 0
}

export function getSchedule(id: number, adminId: number): ScheduleRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM schedules WHERE id = ? AND admin_id = ?')
    .get(id, adminId) as ScheduleRow | undefined
}

export function listSchedules(adminId: number): ScheduleRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM schedules WHERE admin_id = ? ORDER BY next_run_at IS NULL, next_run_at ASC')
    .all(adminId) as ScheduleRow[]
}

export function setScheduleStatus(id: number, adminId: number, status: ScheduleStatus, nextRunAt: number | null): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare(`
    UPDATE schedules SET status = @status, next_run_at = @nextRunAt, updated_at = @now
    WHERE id = @id AND admin_id = @adminId
  `).run({ id, adminId, status, nextRunAt, now: Date.now() })
}

/**
 * Ejecuta fn dentro de una transacción SQLite (commit al final, rollback si
 * lanza). Para operaciones multi-tabla que no pueden quedar a medias
 * (schedule + sus mensajes, etc.).
 */
export function withTransaction<T>(fn: () => T): T {
  if (!db) throw new Error('DB no abierta.')
  return db.transaction(fn)()
}

/** Actualiza el resultado de una ejecución: last_run + próximo vencimiento (o finalizada).
 *
 * Con expectedUpdatedAt (guard de concurrencia) sólo escribe si la fila no
 * fue editada mientras la ejecución estaba en curso: evita que un envío largo
 * pise una edición que cambió horarios o estado (antes, una schedule "once"
 * editada a daily durante el envío terminaba marcada "done").
 *
 * @returns true si escribió; false si la fila cambió (la edición ya avanzó el estado).
 */
export function markScheduleRun(
  id: number,
  lastRunAt: number,
  nextRunAt: number | null,
  done: boolean,
  expectedUpdatedAt?: number | null
): boolean {
  if (!db) throw new Error('DB no abierta.')
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null) {
    const result = db.prepare(`
      UPDATE schedules SET
        last_run_at = @lastRunAt,
        next_run_at = @nextRunAt,
        status = CASE WHEN @done THEN 'done' ELSE status END,
        updated_at = @lastRunAt
      WHERE id = @id AND updated_at = @expected
    `).run({ id, lastRunAt, nextRunAt, done: done ? 1 : 0, expected: expectedUpdatedAt })
    return result.changes > 0
  }
  db.prepare(`
    UPDATE schedules SET
      last_run_at = @lastRunAt,
      next_run_at = @nextRunAt,
      status = CASE WHEN @done THEN 'done' ELSE status END,
      updated_at = @lastRunAt
    WHERE id = @id
  `).run({ id, lastRunAt, nextRunAt, done: done ? 1 : 0 })
  return true
}

export function insertScheduleMessage(
  scheduleId: number,
  accountId: number,
  targetJids: string[],
  text: string,
  decorations: string | null,
  mediaId: number | null = null
): number {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare(`
    INSERT INTO schedule_messages (schedule_id, account_id, target_jids, text, decorations, media_id)
    VALUES (@scheduleId, @accountId, @targetJids, @text, @decorations, @mediaId)
  `).run({
    scheduleId,
    accountId,
    targetJids: JSON.stringify(targetJids),
    text,
    decorations,
    mediaId
  })
  return Number(result.lastInsertRowid)
}

export function listScheduleMessages(scheduleId: number): ScheduleMessageRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM schedule_messages WHERE schedule_id = ? ORDER BY id ASC')
    .all(scheduleId) as ScheduleMessageRow[]
}

export function deleteScheduleMessages(scheduleId: number): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('DELETE FROM schedule_messages WHERE schedule_id = ?').run(scheduleId)
}

/** Cuenta programaciones activas de todos los admins (para el banner). */
export function countActiveSchedules(): number {
  if (!db) throw new Error('DB no abierta.')
  const row = db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'").get() as { n: number }
  return row.n
}

/** Programaciones activas vencidas (para el scheduler).
 *  ORDER BY determinista: las más vencidas primero (sin ORDER BY una schedule
 *  de intervalo corto puede acaparar la ejecución del tick). */
export function getDueSchedules(now: number = Date.now()): ScheduleRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare("SELECT * FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC")
    .all(now) as ScheduleRow[]
}

/* ---------- publish_batch + publish_log ---------- */

/**
 * Crea un nuevo batch vacío. Devuelve el ID del batch.
 * Los targets se agregan con insertPublishLog pasando este batch_id.
 */
export function createPublishBatch(opts: {
  contentType: string
  text: string | null
  mediaPath: string | null
  decorations: string | null
  totalTargets: number
  sentAt: number
  adminId?: number | null
  accountId?: number | null
  scheduleId?: number | null
}): number {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare(`
    INSERT INTO publish_batch (sent_at, content_type, text, media_path, decorations, total_targets, sent_count, failed_count, status, admin_id, account_id, schedule_id)
    VALUES (@sentAt, @contentType, @text, @mediaPath, @decorations, @totalTargets, 0, 0, 'pending', @adminId, @accountId, @scheduleId)
  `).run({
    sentAt: opts.sentAt,
    contentType: opts.contentType,
    text: opts.text,
    mediaPath: opts.mediaPath,
    decorations: opts.decorations,
    totalTargets: opts.totalTargets,
    adminId: opts.adminId ?? null,
    accountId: opts.accountId ?? null,
    scheduleId: opts.scheduleId ?? null
  })
  return Number(result.lastInsertRowid)
}

/**
 * Actualiza un batch con los conteos finales de enviados/fallados.
 */
export function finalizePublishBatch(batchId: number, sentCount: number, failedCount: number): void {
  if (!db) throw new Error('DB no abierta.')
  const status: 'sent' | 'partial' | 'failed' =
    sentCount === 0 ? 'failed' :
    failedCount === 0 ? 'sent' :
    'partial'
  db.prepare(`
    UPDATE publish_batch SET sent_count = ?, failed_count = ?, status = ? WHERE id = ?
  `).run(sentCount, failedCount, status, batchId)
}

/**
 * Inserta un log individual por destino, opcionalmente linked a un batch.
 */
export function insertPublishLog(entry: Omit<PublishLogRow, 'id' | 'batch_id'> & { batch_id?: number | null }): number {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare(`
    INSERT INTO publish_log (batch_id, target_jid, content_type, text, media_path, status, sent_at, error)
    VALUES (@batch_id, @target_jid, @content_type, @text, @media_path, @status, @sent_at, @error)
  `).run({
    batch_id: entry.batch_id ?? null,
    target_jid: entry.target_jid,
    content_type: entry.content_type,
    text: entry.text,
    media_path: entry.media_path,
    status: entry.status,
    sent_at: entry.sent_at,
    error: entry.error
  })
  return Number(result.lastInsertRowid)
}

export function updatePublishLogStatus(id: number, status: 'sent' | 'failed', error: string | null = null): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('UPDATE publish_log SET status = ?, error = ? WHERE id = ?')
    .run(status, error, id)
}

/** Devuelve los últimos N batches del admin dado (o de todos si adminId es null). */
export function getRecentPublishBatches(limit: number = 50, adminId?: number): PublishBatchRow[] {
  if (!db) throw new Error('DB no abierta.')
  if (adminId === undefined) {
    return db.prepare('SELECT * FROM publish_batch ORDER BY sent_at DESC LIMIT ?')
      .all(limit) as PublishBatchRow[]
  }
  return db.prepare('SELECT * FROM publish_batch WHERE admin_id = ? ORDER BY sent_at DESC LIMIT ?')
    .all(adminId, limit) as PublishBatchRow[]
}

/** Devuelve los detalles (targets individuales) de un batch específico. */
export function getPublishLogByBatch(batchId: number): PublishLogRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM publish_log WHERE batch_id = ? ORDER BY id ASC')
    .all(batchId) as PublishLogRow[]
}

/** Devuelve un batch si pertenece al admin dado (para chequear ownership). */
export function getPublishBatchById(batchId: number, adminId?: number): PublishBatchRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  if (adminId === undefined) {
    return db.prepare('SELECT * FROM publish_batch WHERE id = ?').get(batchId) as PublishBatchRow | undefined
  }
  return db.prepare('SELECT * FROM publish_batch WHERE id = ? AND admin_id = ?')
    .get(batchId, adminId) as PublishBatchRow | undefined
}

/** Devuelve los últimos N logs individuales (compat con API vieja). */
export function getRecentPublishLog(limit: number = 50): PublishLogRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM publish_log ORDER BY sent_at DESC LIMIT ?').all(limit) as PublishLogRow[]
}

/* ---------- Diagnóstico (tests) ---------- */

export function _debugListTables(): string[] {
  if (!db) throw new Error('DB no abierta.')
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name)
}

export function _debugListColumns(table: string): string[] {
  if (!db) throw new Error('DB no abierta.')
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name)
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    log.info('SQLite cerrado.')
  }
}
