import { scryptSync, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto'
import {
  getAdminCredentials,
  getAdminByUsername,
  getAdminById,
  insertAdminCredentials,
  updateAdminPassword,
  setAdminDisabled,
  deleteAdmin,
  deleteSessionsForAdmin,
  deleteSession,
  createSession,
  getSessionByTokenHash,
  cleanExpiredSessions,
  listAdmins,
  type AdminRow,
  type AdminRole
} from './db.ts'
import { logger } from './logger.ts'

const log = logger('admin-auth')

/** Duración de una sesión de panel: 7 días. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/

/**
 * Hash de password usando Node.js crypto (sin dependencias externas).
 * Usa scrypt con salt — estándar robusto, sin bcrypt nativo que requiere compilación.
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `scrypt:${salt}:${hash}`
}

/**
 * Verifica una password contra el hash guardado.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split(':')
    if (scheme !== 'scrypt' || !salt || !hash) return false
    const hashBuf = Buffer.from(hash, 'hex')
    const testBuf = scryptSync(password, salt, 64)
    if (hashBuf.length !== testBuf.length) return false
    return timingSafeEqual(hashBuf, testBuf)
  } catch {
    return false
  }
}

/**
 * Hash dummy para igualar el tiempo de respuesta cuando el usuario NO existe
 * (evita enumeración de usuarios por timing: sin esto, "usuario inexistente"
 * responde en ~1ms y "contraseña incorrecta" en ~100ms de scrypt).
 */
let DUMMY_HASH: string | null = null
function dummyVerify(password: string): void {
  if (!DUMMY_HASH) {
    DUMMY_HASH = hashPassword(randomBytes(24).toString('hex'))
  }
  verifyPassword(password, DUMMY_HASH)
}

/**
 * Genera una contraseña aleatoria alfanumérica fácilmente copiable.
 * Formato: 4 grupos de 5 chars separados por guiones: XXXXX-XXXXX-XXXXX-XXXXX
 * Usa un alfabeto sin caracteres ambiguos (sin 0/O/1/I/l).
 */
function generateRandomPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const groups: string[] = []
  for (let g = 0; g < 4; g++) {
    let chunk = ''
    for (let i = 0; i < 5; i++) {
      chunk += alphabet[randomInt(0, alphabet.length)]
    }
    groups.push(chunk)
  }
  return groups.join('-')
}

export interface AdminBootstrapResult {
  username: string
  password: string
  isFirstRun: boolean
  createdAt: number
}

/**
 * Garantiza que exista el admin inicial (superadmin) en la base de datos.
 * Si no existe (primera ejecución), lo genera, lo hashea, lo guarda en SQL
 * y devuelve las credenciales en claro UNA SOLA VEZ para mostrarlas en consola.
 *
 * Si ya existen admins, devuelve null (no revela nada).
 */
export function ensureAdminCredentials(): AdminBootstrapResult | null {
  const existing = getAdminCredentials()
  if (existing) {
    log.info(`Admins existentes: ${listAdmins().length} (superadmin: ${listAdmins().filter(a => a.role === 'superadmin').length}).`)
    return null
  }

  // Docker/Render: credenciales definidas en el entorno (nunca se imprimen en logs)
  const envUser = (process.env.ADMIN_USER ?? '').trim()
  const envPass = process.env.ADMIN_PASSWORD ?? ''
  if (envUser && USERNAME_RE.test(envUser) && isValidPassword(envPass)) {
    insertAdminCredentials(envUser, hashPassword(envPass), 'superadmin', Date.now())
    log.warn(`PRIMERA EJECUCIÓN — superadmin "${envUser}" creado desde ADMIN_USER/ADMIN_PASSWORD del entorno.`)
    return null
  }
  if (envUser || envPass) {
    log.warn('ADMIN_USER/ADMIN_PASSWORD inválidos (usuario 3-32 chars, password 8-128): se genera contraseña aleatoria.')
  }

  const username = 'admin'
  const password = generateRandomPassword()
  const hash = hashPassword(password)
  const createdAt = Date.now()

  insertAdminCredentials(username, hash, 'superadmin', createdAt)

  log.warn('PRIMERA EJECUCIÓN — cuenta superadmin generada automáticamente.')
  log.warn(`Usuario: ${username}`)

  return { username, password, isFirstRun: true, createdAt }
}

/* ---------- Gestión de administradores ---------- */

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username)
}

export function isValidPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128
}

export interface CreateAdminResult {
  ok: boolean
  error?: string
  id?: number
}

/** Crea un admin nuevo (username único, password >= 8 chars). */
export function createAdmin(username: string, password: string, role: AdminRole = 'admin'): CreateAdminResult {
  if (!isValidUsername(username)) {
    return { ok: false, error: 'Usuario inválido: 3-32 chars, letras/números/_ . -' }
  }
  if (!isValidPassword(password)) {
    return { ok: false, error: 'Contraseña inválida: mínimo 8 caracteres.' }
  }
  if (role !== 'admin' && role !== 'superadmin') {
    return { ok: false, error: 'Rol inválido.' }
  }
  if (getAdminByUsername(username)) {
    return { ok: false, error: 'Ese nombre de usuario ya existe.' }
  }
  const id = insertAdminCredentials(username, hashPassword(password), role)
  log.info(`Admin creado: ${username} (${role}).`)
  return { ok: true, id }
}

/** Cambia la contraseña de un admin y mata todas sus sesiones activas. */
export function resetAdminPassword(username: string, newPassword: string): CreateAdminResult {
  const row = getAdminByUsername(username)
  if (!row) return { ok: false, error: 'No existe ese usuario.' }
  if (!isValidPassword(newPassword)) {
    return { ok: false, error: 'Contraseña inválida: mínimo 8 caracteres.' }
  }
  updateAdminPassword(username, hashPassword(newPassword))
  deleteSessionsForAdmin(row.id)
  log.info(`Contraseña de ${username} actualizada (sesiones revocadas).`)
  return { ok: true, id: row.id }
}

export function disableAdmin(id: number): void {
  setAdminDisabled(id, true)
  deleteSessionsForAdmin(id)
  log.info(`Admin ${id} deshabilitado y sus sesiones revocadas.`)
}

export function enableAdmin(id: number): void {
  setAdminDisabled(id, false)
  log.info(`Admin ${id} habilitado.`)
}

export function removeAdmin(id: number): void {
  deleteSessionsForAdmin(id)
  deleteAdmin(id)
  log.info(`Admin ${id} eliminado (junto a sus cuentas, plantillas y programaciones).`)
}

export { listAdmins }

/* ---------- Sesiones del panel ---------- */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface LoginResult {
  ok: boolean
  error?: string
  token?: string
  admin?: { id: number; username: string; role: AdminRole }
}

/**
 * Verifica credenciales y crea una sesión nueva.
 * Devuelve el token en claro (sólo acá se ve; en la DB queda su hash).
 */
export function loginWithCredentials(username: string, password: string): LoginResult {
  const row = getAdminByUsername(String(username ?? '').trim())
  if (!row || row.disabled === 1) {
    // Tiempo equivalente al camino con scrypt para no filtrar por timing
    // si el usuario existe o no.
    dummyVerify(password)
    return { ok: false, error: 'Usuario o contraseña incorrectos.' }
  }
  if (!verifyPassword(password, row.password_hash)) {
    return { ok: false, error: 'Usuario o contraseña incorrectos.' }
  }

  cleanExpiredSessions()

  const token = randomBytes(32).toString('hex')
  createSession(sha256Hex(token), row.id, Date.now() + SESSION_TTL_MS)

  log.info(`Login correcto: ${row.username} (${row.role}).`)

  return {
    ok: true,
    token,
    admin: { id: row.id, username: row.username, role: row.role }
  }
}

/** Valida un token de sesión y devuelve el admin asociado (o undefined). */
export function validateSessionToken(token: string): AdminRow | undefined {
  if (!token || token.length < 32) return undefined
  const session = getSessionByTokenHash(sha256Hex(token))
  if (!session) return undefined
  // getSessionByTokenHash ya filtra expiradas y admins deshabilitados vía JOIN,
  // pero el JOIN plana columnas: recuperamos el admin completo por id.
  const admin = getAdminById(session.admin_id)
  if (!admin || admin.disabled === 1) return undefined
  return admin
}

/** Cierra la sesión del token dado. */
export function logoutToken(token: string): void {
  if (!token) return
  deleteSession(sha256Hex(token))
}

/* ---------- Rate limit de login (en memoria) ----------
 *
 * Dos contadores independientes:
 *  - por IP (server.ts lo consulta en el hook): frena fuerza bruta desde un
 *    mismo origen. Detrás de un proxy que reescribe X-Forwarded-For puede ser
 *    bypasseable, por eso existe también el contador por usuario.
 *  - por USERNAME (routes/auth.ts): global, inmune al spoofing de IP —
 *    aunque roten las IPs, la cuenta objetivo queda bloqueada.
 */

const LOGIN_ATTEMPTS = new Map<string, { count: number; resetAt: number }>()
const USER_LOGIN_ATTEMPTS = new Map<string, { count: number; resetAt: number }>()
const MAX_LOGIN_ATTEMPTS = 8
const MAX_USER_LOGIN_ATTEMPTS = 6
const LOGIN_WINDOW_MS = 15 * 60 * 1000

function pruneAttempts (map: Map<string, { count: number; resetAt: number }>, now: number): void {
  if (map.size > 5000) {
    for (const [key, entry] of map) {
      if (now > entry.resetAt) map.delete(key)
    }
  }
}

/** ¿Esta IP está bloqueada por demasiados intentos de login fallidos? */
export function isLoginBlocked(ip: string): boolean {
  const entry = LOGIN_ATTEMPTS.get(ip)
  if (!entry) return false
  if (Date.now() > entry.resetAt) {
    LOGIN_ATTEMPTS.delete(ip)
    return false
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS
}

export function registerLoginFailure(ip: string): void {
  const now = Date.now()
  pruneAttempts(LOGIN_ATTEMPTS, now)
  const entry = LOGIN_ATTEMPTS.get(ip)
  if (!entry || now > entry.resetAt) {
    LOGIN_ATTEMPTS.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return
  }
  entry.count++
}

export function clearLoginFailures(ip: string): void {
  LOGIN_ATTEMPTS.delete(ip)
}

function userKey(username: string): string {
  return username.trim().toLowerCase()
}

/** ¿Este usuario está bloqueado por demasiados intentos fallidos? */
export function isUserLoginBlocked(username: string): boolean {
  const key = userKey(username)
  if (!key) return false
  const entry = USER_LOGIN_ATTEMPTS.get(key)
  if (!entry) return false
  if (Date.now() > entry.resetAt) {
    USER_LOGIN_ATTEMPTS.delete(key)
    return false
  }
  return entry.count >= MAX_USER_LOGIN_ATTEMPTS
}

export function registerUserLoginFailure(username: string): void {
  const key = userKey(username)
  if (!key) return
  const now = Date.now()
  pruneAttempts(USER_LOGIN_ATTEMPTS, now)
  const entry = USER_LOGIN_ATTEMPTS.get(key)
  if (!entry || now > entry.resetAt) {
    USER_LOGIN_ATTEMPTS.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return
  }
  entry.count++
}

export function clearUserLoginFailures(username: string): void {
  USER_LOGIN_ATTEMPTS.delete(userKey(username))
}

/**
 * Renderiza un cuadro ANSI bonito con las credenciales generadas (sólo primera vez).
 */
export function printCredentialsBox(creds: AdminBootstrapResult): void {
  const { username, password } = creds
  const lines = [
    '',
    '╔════════════════════════════════════════════════════════════════╗',
    '║                                                                  ║',
    '║   🔐  CUENTA SUPERADMIN DEL PANEL — PRIMERA EJECUCIÓN           ║',
    '║                                                                  ║',
    '║                                                                  ║',
    `║   Usuario:    ${username.padEnd(48)}║`,
    '║                                                                  ║',
    `║   Contraseña: ${password.padEnd(48)}║`,
    '║                                                                  ║',
    '║                                                                  ║',
    '║   ⚠️  Guardá estas credenciales en un lugar seguro.              ║',
    '║   No se volverán a mostrar. Con ella podés entrar al panel      ║',
    '║   y crear más administradores desde la vista "Usuarios".        ║',
    '║                                                                  ║',
    '║   El panel web escucha en el puerto configurado (default 3000)  ║',
    '║   tan pronto arranca el proceso, aunque WhatsApp aún no esté    ║',
    '║   conectado.                                                     ║',
    '║                                                                  ║',
    '╚════════════════════════════════════════════════════════════════╝',
    ''
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

// Re-export para que el panel web pueda usarla
export { hashPassword }
