import { scryptSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { getAdminCredentials, insertAdminCredentials } from './db.ts'
import { logger } from './logger.ts'

const log = logger('admin-auth')

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

/**
 * Genera un nombre de usuario único. Por defecto 'admin', pero si se quiere
 * soportar múltiples admins en el futuro, podría ser 'admin' + sufijo.
 */
function generateUsername(): string {
  // Por ahora siempre 'admin'. La columna UNIQUE lo protege.
  return 'admin'
}

export interface AdminBootstrapResult {
  username: string
  password: string
  isFirstRun: boolean
  createdAt: number
}

/**
 * Garantiza que existan credenciales admin en la base de datos.
 * Si no existen (primera ejecución), las genera, las hashea, las guarda en SQL
 * y las devuelve en claro UNA SOLA VEZ para mostrarlas en consola.
 *
 * Si ya existen, devuelve null (no revela la password).
 */
export function ensureAdminCredentials(): AdminBootstrapResult | null {
  const existing = getAdminCredentials()
  if (existing) {
    log.info(`Credenciales admin existentes (usuario: ${existing.username}, creado ${new Date(existing.first_run).toISOString()}).`)
    return null
  }

  const username = generateUsername()
  const password = generateRandomPassword()
  const hash = hashPassword(password)
  const createdAt = Date.now()

  insertAdminCredentials(username, hash, createdAt)

  log.warn('PRIMERA EJECUCIÓN — credenciales admin generadas automáticamente.')
  log.warn(`Usuario: ${username}`)

  return { username, password, isFirstRun: true, createdAt }
}

/**
 * Verifica un intento de login.
 * Devuelve true si coincide, false si no.
 */
export function verifyLogin(username: string, password: string): boolean {
  const row = getAdminCredentials()
  if (!row) return false
  if (row.username !== username) return false
  return verifyPassword(password, row.password_hash)
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
    '║   🔐  CREDENCIALES DEL PANEL WEB ADMIN — PRIMERA EJECUCIÓN      ║',
    '║                                                                  ║',
    '║                                                                  ║',
    `║   Usuario:    ${username.padEnd(48)}║`,
    '║                                                                  ║',
    `║   Contraseña: ${password.padEnd(48)}║`,
    '║                                                                  ║',
    '║                                                                  ║',
    '║   ⚠️  Guardá estas credenciales en un lugar seguro.              ║',
    '║   No se volverán a mostrar. Si las perdés, tendrás que          ║',
    '║   borrar la fila admin_credentials de la DB y reiniciar.         ║',
    '║                                                                  ║',
    '║   El panel web (fase 2) escuchará en http://localhost:3000      ║',
    '║   cuando lo actives.                                             ║',
    '║                                                                  ║',
    '╚════════════════════════════════════════════════════════════════╝',
    ''
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

// Re-export para que el panel web pueda usarla
export { hashPassword }
