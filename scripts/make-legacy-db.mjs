/* Crea una base SQLite con el esquema VIEJO de la v2 (mono-cuenta)
   + una sesión legacy falsa en data/auth/, para probar la migración.
   Se ejecuta desde el directorio del proyecto fusionado. */
import Database from 'better-sqlite3'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

rmSync('data', { recursive: true, force: true })
mkdirSync('data/auth', { recursive: true })

const db = new Database('data/bot.db')
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE admin_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, first_run INTEGER NOT NULL DEFAULT 1);
INSERT INTO admin_credentials (username, password_hash, created_at, first_run) VALUES ('miadmin','scrypt$xyz',1789000000000,0);
CREATE TABLE publish_batch (id INTEGER PRIMARY KEY AUTOINCREMENT, sent_at INTEGER NOT NULL, content_type TEXT NOT NULL, text TEXT, media_path TEXT, media_type TEXT, media_name TEXT, decorations TEXT, buttons TEXT, total_targets INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE publish_log (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, target_jid TEXT NOT NULL, content_type TEXT NOT NULL, text TEXT, media_path TEXT, status TEXT NOT NULL DEFAULT 'pending', sent_at INTEGER NOT NULL, error TEXT);
CREATE TABLE groups_cache (jid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', is_admin INTEGER NOT NULL DEFAULT 0, is_owner INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL);
INSERT INTO groups_cache VALUES ('1203@g.us','Mi grupo','1','0',1789000000000);
`)
db.close()

// Sesión legacy falsa (formato v2: creds.json directo en data/auth/)
writeFileSync('data/auth/creds.json', JSON.stringify({ noiseKey: [1], signedIdentityKey: { private: 'x' } }))
writeFileSync('data/auth/session-abc.json', '1234567890')

console.log('DB v2 + sesión legacy creadas.')
