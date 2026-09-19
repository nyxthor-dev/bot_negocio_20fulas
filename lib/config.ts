import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const CONFIG_PATH = resolve(__dirname, '..', 'config.json')

export type PairingMethod = 'qr' | 'code'

export interface BotConfig {
  bot: {
    phone: string
    name: string
    pairingMethod: PairingMethod | null  // null = preguntar por consola
  }
  storage: {
    authFolder: string
    dbPath: string
  }
  logging: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  }
  web: {
    enabled: boolean
    port: number
    host: string
  }
}

const DEFAULTS = {
  bot: {
    name: 'publisher-manager-bot',
    pairingMethod: null as PairingMethod | null
  },
  storage: {
    authFolder: './data/auth',
    dbPath: './data/bot.db'
  },
  logging: {
    level: 'info' as BotConfig['logging']['level']
  },
  web: {
    enabled: false,
    port: 3000,
    host: '0.0.0.0'
  }
}

function deepMerge<T>(base: T, override: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return (override ?? base) as T
  }
  if (typeof override !== 'object' || override === null) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const k of Object.keys(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[k]
    const overrideVal = (override as Record<string, unknown>)[k]
    out[k] =
      baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal)
        ? deepMerge(baseVal, overrideVal)
        : overrideVal
  }
  return out as T
}

function validate(cfg: BotConfig): void {
  const errs: string[] = []
  if (!cfg.bot?.phone || !/^\d{7,15}$/.test(cfg.bot.phone.replace(/[^\d]/g, ''))) {
    errs.push('bot.phone debe ser un número de teléfono válido (7-15 dígitos, sólo números)')
  }
  if (cfg.bot.pairingMethod !== null && !['qr', 'code'].includes(cfg.bot.pairingMethod)) {
    errs.push('bot.pairingMethod debe ser "qr", "code" o null')
  }
  if (!cfg.storage?.authFolder || typeof cfg.storage.authFolder !== 'string') {
    errs.push('storage.authFolder debe ser un string con la ruta a la carpeta de sesión')
  }
  if (!cfg.storage?.dbPath || typeof cfg.storage.dbPath !== 'string') {
    errs.push('storage.dbPath debe ser un string con la ruta a la base de datos SQLite')
  }
  const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
  if (!cfg.logging?.level || !validLevels.includes(cfg.logging.level)) {
    errs.push(`logging.level debe ser uno de: ${validLevels.join(', ')}`)
  }
  if (typeof cfg.web?.enabled !== 'boolean') {
    errs.push('web.enabled debe ser boolean')
  }
  if (!Number.isInteger(cfg.web?.port) || cfg.web.port < 1 || cfg.web.port > 65535) {
    errs.push('web.port debe ser entero entre 1 y 65535')
  }
  if (typeof cfg.web?.host !== 'string' || cfg.web.host.length === 0) {
    errs.push('web.host debe ser string no vacío')
  }
  if (errs.length) {
    throw new Error('config.json inválido:\n  - ' + errs.join('\n  - '))
  }
}

let cached: BotConfig | null = null

/** Lee y valida config.json. Lanza error si falta o es inválido. */
export function loadConfig(): BotConfig {
  if (cached) return cached
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `No se encontró config.json en ${CONFIG_PATH}.\n` +
      `Copiá config.example.json a config.json y editá los valores.`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch (e) {
    throw new Error(`config.json tiene JSON inválido: ${(e as Error).message}`)
  }
  const merged = deepMerge(DEFAULTS, parsed) as BotConfig
  validate(merged)
  cached = merged
  return merged
}

/** Devuelve la ruta absoluta al config.json (para logs o errores). */
export function getConfigPath(): string {
  return CONFIG_PATH
}
