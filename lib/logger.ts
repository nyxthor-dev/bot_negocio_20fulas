import pino from 'pino'

// Símbolos y colores por nivel
const LEVEL_META: Record<string, { symbol: string; color: string; label: string }> = {
  trace: { symbol: '◦', color: '\x1b[90m', label: 'TRACE' },
  debug: { symbol: '◦', color: '\x1b[90m', label: 'DEBUG' },
  info:  { symbol: '✓', color: '\x1b[32m', label: 'INFO ' },
  warn:  { symbol: '⚠', color: '\x1b[33m', label: 'WARN ' },
  error: { symbol: '✗', color: '\x1b[31m', label: 'ERR ' },
  fatal: { symbol: '✗', color: '\x1b[35m', label: 'FATAL' }
}
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'

const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const MAX_VALUE_LEN = 200

function truncate(s: string, max = MAX_VALUE_LEN): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Formatea cualquier valor a string legible en una sola línea.
 * Objetos → JSON compacto (sin saltos de línea).
 * Strings largos → truncados con ellipsis.
 * Errores → mensaje (sin stack completo, ya que baileys loguea el stack).
 */
function formatValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return truncate(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Error) {
    return truncate(v.message)
  }
  if (typeof v === 'object') {
    // Caso especial: objeto tipo { err: Error, msg: string } que pino mete
    const obj = v as Record<string, unknown>
    if (typeof obj.message === 'string' && typeof obj.stack === 'string') {
      return truncate(obj.message)
    }
    if (typeof obj.message === 'string' && typeof obj.type === 'string') {
      return truncate(`${obj.type}: ${obj.message}`)
    }
    try {
      // JSON compacto en una sola línea, sin Buffer/BigInt
      const safe = JSON.stringify(v, (_key, value) => {
        if (typeof value === 'bigint') return value.toString()
        if (Buffer.isBuffer(value)) return `<Buffer ${value.length}b>`
        return value
      })
      return truncate(safe || String(v))
    } catch {
      return truncate(String(v))
    }
  }
  return truncate(String(v))
}

/**
 * Formatea extras a "key=value" compacto en una línea.
 * Ej: { jid: 'foo@g.us', messageId: 'ABC' } → "jid=foo@g.us messageId=ABC"
 */
function formatExtras(obj: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    let val: string
    if (typeof v === 'string') {
      val = truncate(v, 100)
    } else {
      val = formatValue(v)
    }
    parts.push(`${DIM}${k}=${RESET}${val}`)
  }
  return parts.length ? ` ${DIM}{${RESET} ${parts.join(' ')} ${DIM}}${RESET}` : ''
}

const prettyStream = {
  write(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      const levelNum = obj.level as number
      const levelLabel = pino.levels.labels[levelNum] ?? 'INFO'
      const meta = LEVEL_META[levelLabel] ?? LEVEL_META.info
      const msg = (obj.msg as string) || ''
      const module = obj.module as string | undefined
      // Usar (mod) en vez de [mod] para evitar conflicto con código ANSI
      // cuando un reset/escape queda inmediatamente antes del [.
      const moduleTag = module ? `(${module})` : ''

      // Filtrar extras que no aportan info útil en logs
      const extras: Record<string, unknown> = {}
      for (const k of Object.keys(obj)) {
        if (['level', 'time', 'msg', 'module', 'pid', 'hostname'].includes(k)) continue
        const v = obj[k]
        if (v === undefined) continue
        // Filtrar objetos SessionEntry (ruido de libsignal)
        if (typeof v === 'object' && v !== null && typeof (v as { _chains?: unknown })._chains === 'object') {
          extras[k] = '<SessionEntry>'
          continue
        }
        extras[k] = v
      }
      const extraStr = formatExtras(extras)

      process.stdout.write(
        `${meta.color}${meta.symbol}${RESET} ${meta.color}${meta.label}${RESET} ${moduleTag} ${msg}${extraStr}\n`
      )
    } catch {
      // Si no es JSON (mensaje suelto), lo imprimimos tal cual
      process.stdout.write(trimmed + '\n')
    }
  }
}

const root = pino(
  { level: LOG_LEVEL, base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
  prettyStream
)

export function logger(module?: string): pino.Logger {
  return module ? root.child({ module }) : root
}

export default logger
