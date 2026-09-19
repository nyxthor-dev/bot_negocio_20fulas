import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.ts'

const log = logger('db')

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = resolve(__dirname, '..', 'data', 'bot.db')

export interface AdminCredentialsRow {
  id: number
  username: string
  password_hash: string
  created_at: number
  first_run: number
}

/**
 * Una publicación batch (un envío a múltiples destinos = 1 registro).
 * El historial del panel muestra estas, no los destinos individuales.
 */
export interface PublishBatchRow {
  id: number
  sent_at: number
  content_type: string    // 'text' | 'image' | 'video' | ...
  text: string | null
  media_path: string | null
  media_type: string | null   // MediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  media_name: string | null   // nombre original del archivo
  decorations: string | null  // JSON serializado de DecorationOptions
  buttons: string | null      // JSON serializado de ButtonSpec[]
  total_targets: number        // cuántos destinos en este batch
  sent_count: number           // cuántos OK
  failed_count: number         // cuántos fallaron
  status: 'sent' | 'partial' | 'failed'   // resumen
}

/**
 * Detalle por destino dentro de un batch.
 */
export interface PublishLogRow {
  id: number
  batch_id: number | null    // null = publicación legacy sin batch (compat)
  target_jid: string
  content_type: string
  text: string | null
  media_path: string | null
  status: 'pending' | 'sent' | 'failed'
  sent_at: number
  error: string | null
}

export interface GroupCacheRow {
  jid: string
  name: string
  is_admin: number
  is_owner: number
  last_seen: number
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
  log.info(`SQLite abierto: ${dbPath}`)

  return db
}

function createSchema(d: Database.Database): void {
  // 1. Tablas base (CREATE IF NOT EXISTS — no rompe si ya existen con esquema viejo)
  d.exec(`
    CREATE TABLE IF NOT EXISTS admin_credentials (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT    UNIQUE NOT NULL,
      password_hash   TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      first_run       INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS publish_batch (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at         INTEGER NOT NULL,
      content_type    TEXT    NOT NULL,
      text            TEXT,
      media_path      TEXT,
      media_type      TEXT,
      media_name      TEXT,
      decorations     TEXT,
      buttons         TEXT,
      total_targets   INTEGER NOT NULL DEFAULT 0,
      sent_count      INTEGER NOT NULL DEFAULT 0,
      failed_count    INTEGER NOT NULL DEFAULT 0,
      status          TEXT    NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS publish_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      target_jid      TEXT    NOT NULL,
      content_type    TEXT    NOT NULL,
      text            TEXT,
      media_path      TEXT,
      status          TEXT    NOT NULL DEFAULT 'pending',
      sent_at         INTEGER NOT NULL,
      error           TEXT
    );

    CREATE TABLE IF NOT EXISTS groups_cache (
      jid             TEXT PRIMARY KEY,
      name            TEXT NOT NULL DEFAULT '',
      is_admin        INTEGER NOT NULL DEFAULT 0,
      is_owner        INTEGER NOT NULL DEFAULT 0,
      last_seen       INTEGER NOT NULL
    );
  `)

  // 2. Migraciones: agregar columnas faltantes a tablas existentes (idempotente)
  migrateSchema(d)

  // 3. Índices — se crean DESPUÉS de migrar para que las columnas existan
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_publish_batch_sent_at ON publish_batch(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_publish_log_sent_at ON publish_log(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_publish_log_batch_id ON publish_log(batch_id);
  `)
}

/**
 * Migraciones idempotentes: si la DB ya existe con esquema viejo,
 * agregamos las columnas/tablas nuevas sin perder datos.
 */
function migrateSchema(d: Database.Database): void {
  // 1. Agregar batch_id a publish_log si no existe
  const cols = d.prepare("PRAGMA table_info(publish_log)").all() as { name: string }[]
  const hasBatchId = cols.some(c => c.name === 'batch_id')
  if (!hasBatchId) {
    d.exec("ALTER TABLE publish_log ADD COLUMN batch_id INTEGER REFERENCES publish_batch(id) ON DELETE CASCADE;")
    log.info('Migración: agregada columna batch_id a publish_log.')
  }

  // 2. Agregar columnas nuevas a publish_batch
  const batchCols = d.prepare("PRAGMA table_info(publish_batch)").all() as { name: string }[]
  const hasMediaType = batchCols.some(c => c.name === 'media_type')
  if (!hasMediaType) {
    try { d.exec("ALTER TABLE publish_batch ADD COLUMN media_type TEXT;") } catch { /* sinop */ }
    try { d.exec("ALTER TABLE publish_batch ADD COLUMN media_name TEXT;") } catch { /* sinop */ }
    try { d.exec("ALTER TABLE publish_batch ADD COLUMN buttons TEXT;") } catch { /* sinop */ }
    log.info('Migración: agregadas columnas media_type, media_name y buttons a publish_batch.')
  }
}

/* ---------- admin_credentials ---------- */

export function getAdminCredentials(): AdminCredentialsRow | undefined {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM admin_credentials LIMIT 1').get() as AdminCredentialsRow | undefined
}

export function insertAdminCredentials(username: string, passwordHash: string, firstRun: number = Date.now()): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare(`
    INSERT INTO admin_credentials (username, password_hash, created_at, first_run)
    VALUES (@username, @passwordHash, @createdAt, @firstRun)
  `).run({ username, passwordHash, createdAt: firstRun, firstRun })
}

export function updateAdminPassword(username: string, passwordHash: string): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare('UPDATE admin_credentials SET password_hash = ? WHERE username = ?')
    .run(passwordHash, username)
}

/* ---------- groups_cache ---------- */

export function upsertGroup(row: Omit<GroupCacheRow, 'last_seen'> & { last_seen?: number }): void {
  if (!db) throw new Error('DB no abierta.')
  db.prepare(`
    INSERT INTO groups_cache (jid, name, is_admin, is_owner, last_seen)
    VALUES (@jid, @name, @isAdmin, @isOwner, @lastSeen)
    ON CONFLICT(jid) DO UPDATE SET
      name      = excluded.name,
      is_admin  = excluded.is_admin,
      is_owner  = excluded.is_owner,
      last_seen = excluded.last_seen
  `).run({
    jid: row.jid,
    name: row.name,
    isAdmin: row.is_admin,
    isOwner: row.is_owner,
    lastSeen: row.last_seen ?? Date.now()
  })
}

export function getAdminGroups(): GroupCacheRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM groups_cache WHERE is_admin = 1 ORDER BY name COLLATE NOCASE ASC')
    .all() as GroupCacheRow[]
}

export function getAllCachedGroups(): GroupCacheRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM groups_cache ORDER BY name COLLATE NOCASE ASC').all() as GroupCacheRow[]
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
  mediaType?: string | null
  mediaName?: string | null
  decorations: string | null
  buttons: string | null
  totalTargets: number
  sentAt: number
}): number {
  if (!db) throw new Error('DB no abierta.')
  const result = db.prepare(`
    INSERT INTO publish_batch (sent_at, content_type, text, media_path, media_type, media_name, decorations, buttons, total_targets, sent_count, failed_count, status)
    VALUES (@sentAt, @contentType, @text, @mediaPath, @mediaType, @mediaName, @decorations, @buttons, @totalTargets, 0, 0, 'pending')
  `).run({
    sentAt: opts.sentAt,
    contentType: opts.contentType,
    text: opts.text,
    mediaPath: opts.mediaPath,
    mediaType: opts.mediaType ?? null,
    mediaName: opts.mediaName ?? null,
    decorations: opts.decorations,
    buttons: opts.buttons,
    totalTargets: opts.totalTargets
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

/**
 * Devuelve los últimos N batches (cada uno = 1 publicación agrupada).
 */
export function getRecentPublishBatches(limit: number = 50): PublishBatchRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM publish_batch ORDER BY sent_at DESC LIMIT ?')
    .all(limit) as PublishBatchRow[]
}

/**
 * Devuelve los detalles (targets individuales) de un batch específico.
 */
export function getPublishLogByBatch(batchId: number): PublishLogRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM publish_log WHERE batch_id = ? ORDER BY id ASC')
    .all(batchId) as PublishLogRow[]
}

/**
 * Devuelve los últimos N logs individuales (compat con API vieja).
 */
export function getRecentPublishLog(limit: number = 50): PublishLogRow[] {
  if (!db) throw new Error('DB no abierta.')
  return db.prepare('SELECT * FROM publish_log ORDER BY sent_at DESC LIMIT ?').all(limit) as PublishLogRow[]
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    log.info('SQLite cerrado.')
  }
}
