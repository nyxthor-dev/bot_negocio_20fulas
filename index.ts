import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs'
import { startScheduler, stopScheduler } from './lib/scheduler.ts'
import {
  startAllSavedAccounts,
  stopAllAccounts,
  configureAuthRoot,
  setAccountReadyCallback
} from './lib/client.ts'
import { executeAndLog } from './lib/publishService.ts'
import { loadConfig } from './lib/config.ts'
import {
  openDatabase,
  closeDatabase,
  listAccounts,
  listAdmins,
  countActiveSchedules,
  insertAccount
} from './lib/db.ts'
import { ensureAdminCredentials, printCredentialsBox } from './lib/adminAuth.ts'
import { configureMediaDir } from './lib/media.ts'
import { silenceConsoleNoise } from './lib/consoleFilter.ts'
import { logger } from './lib/logger.ts'
import { startWebServer, stopWebServer } from './web/server.ts'

const log = logger('index')

silenceConsoleNoise()

/* ---------- Red de seguridad del proceso ----------
 *
 * Sin esto, una promesa rechazada sin handler (un callback de Baileys, un
 * error de disco en saveCreds, un EPIPE en stdout) tumba TODO el proceso
 * en Node >= 15: panel web, scheduler y todas las sesiones de WhatsApp.
 *
 *  - unhandledRejection: se loguea y se sigue (el estado no está corrupto).
 *  - uncaughtException: se loguea y se sale con código 1 (estado potencial-
 *    mente corrupto; Render/Docker/systemd reinician el proceso).
 */
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Promesa rechazada sin handler (el proceso sigue).')
})
process.on('uncaughtException', (err) => {
  try {
    log.error({ err }, 'Excepción no capturada: se cierra el proceso para reinicio limpio.')
  } finally {
    process.exit(1)
  }
})

const __dirname = dirname(fileURLToPath(import.meta.url))

const CYAN = '\x1b[36m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

/** Limpia la consola con ANSI. Sólo si es TTY. */
function clearConsole(): void {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
  }
}

// Flag global: el banner se imprime UNA sola vez en toda la vida del proceso.
let bannerAlreadyPrinted = false

/**
 * Banner ASCII del usuario.
 * Debajo: stats compactas en una sola línea.
 */
function printBanner(opts: {
  adminsCount: number
  accountsTotal: number
  accountsConnected: number
  activeSchedules: number
  webUrl: string | null
}): void {
  if (bannerAlreadyPrinted) return
  bannerAlreadyPrinted = true

  const { adminsCount, accountsTotal, accountsConnected, activeSchedules, webUrl } = opts

  const lines: string[] = []
  // Banner ASCII arte del usuario
  lines.push('.----------------------------------------------------------.')
  lines.push('|░█▀█░█░█░█▀▄░█░░░▀█▀░█▀▀░█░█░░░█▄█░█▀█░█▀█░█▀█░█▀▀░█▀▀░█▀▄|')
  lines.push('|░█▀▀░█░█░█▀▄░█░░░░█░░▀▀█░█▀█░░░█░█░█▀█░█░█░█▀█░█░█░█▀▀░█▀▄|')
  lines.push('|░▀░░░▀▀▀░▀▀░░▀▀▀░▀▀▀░▀▀▀░▀░▀░░░▀░▀░▀░▀░▀░▀░▀░▀░▀▀▀░▀▀▀░▀░▀|')
  lines.push("'----------------------------------------------------------'")
  lines.push('')

  const accountsIcon = accountsConnected > 0 ? GREEN + '✓' + RESET : YELLOW + '○' + RESET
  const accountsPart = `${accountsIcon} ${DIM}Cuentas${RESET} ${GREEN}${accountsConnected}${RESET}${DIM}/${RESET}${accountsTotal}`
  const adminsPart = `${DIM}Admins${RESET} ${CYAN}${adminsCount}${RESET}`
  const schedulesPart = `${DIM}Programadas${RESET} ${CYAN}${activeSchedules}${RESET}`
  const webPart = webUrl
    ? `${DIM}Panel${RESET} ${CYAN}${webUrl}${RESET}`
    : `${DIM}Panel${RESET} ${YELLOW}off${RESET}`

  process.stdout.write(lines.join('\n') + '\n')
  process.stdout.write(`  ${accountsPart}  ${adminsPart}  ${schedulesPart}  ${webPart}\n\n`)
}

function currentStats(webUrl: string | null) {
  const accounts = listAccounts()
  const connected = accounts.filter(a => a.status === 'connected').length
  return {
    adminsCount: listAdmins().length,
    accountsTotal: accounts.length,
    accountsConnected: connected,
    activeSchedules: countActiveSchedules(),
    webUrl
  }
}

/**
 * Migración desde la v2 (mono-cuenta): si la carpeta de sesión tiene
 * creds.json directo en la raíz (formato viejo) y todavía no hay cuentas
 * registradas, se crea la primera cuenta "Cuenta principal" y se mueve la
 * sesión a data/auth/<account_id> (formato nuevo). Así no hay que
 * re-escanear el QR al pasar de la versión 2 a esta.
 */
function importLegacySessionIfNeeded(authRoot: string, fallbackPhone: string): void {
  try {
    if (listAccounts().length > 0) return
    if (!existsSync(join(authRoot, 'creds.json'))) return

    const admins = listAdmins()
    if (admins.length === 0) {
      log.warn('Migración v2: hay sesión legacy pero no hay admins; se omite.')
      return
    }

    const accountId = insertAccount(admins[0].id, 'Cuenta principal', fallbackPhone)
    const targetDir = join(authRoot, String(accountId))
    mkdirSync(targetDir, { recursive: true })

    // Mover TODO el contenido de la raíz (creds.json, session-*.json, etc.)
    // a la subcarpeta de la cuenta. Si algo falla, se continua con lo demás.
    for (const entry of readdirSync(authRoot)) {
      if (entry === String(accountId)) continue
      try {
        renameSync(join(authRoot, entry), join(targetDir, entry))
      } catch (err) {
        log.warn({ err }, `Migración v2: no se pudo mover ${entry}.`)
      }
    }

    log.info(`Migración v2: sesión importada como cuenta #${accountId} ("Cuenta principal").`)
  } catch (err) {
    // Best-effort: si falla, el usuario siempre puede vincular de nuevo desde el panel.
    log.warn({ err }, 'Migración v2: no se pudo importar la sesión legacy.')
  }
}

async function main(): Promise<void> {
  clearConsole()
  const cfg = loadConfig()
  process.env.LOG_LEVEL = cfg.logging.level

  // 1. Abrir SQLite (incluye migraciones desde el esquema v2)
  openDatabase(cfg.storage.dbPath)

  // 2. Bootstrap del admin inicial (superadmin, sólo si no hay ninguno)
  const adminCreds = ensureAdminCredentials()
  if (adminCreds) {
    printCredentialsBox(adminCreds)
  }

  // 3. Arrancar el panel web INMEDIATAMENTE (antes que WhatsApp)
  let webUrl: string | null = null
  if (cfg.web.enabled) {
    try {
      const result = await startWebServer({ host: cfg.web.host, port: cfg.web.port })
      webUrl = result.url
    } catch (err) {
      log.error({ err }, 'No se pudo arrancar el panel web.')
    }
  }

  // 4. Preparar la carpeta de sesiones (una subcarpeta por cuenta) y la de multimedia
  const authRoot = resolve(__dirname, cfg.storage.authFolder)
  configureAuthRoot(authRoot)
  configureMediaDir(resolve(__dirname, dirname(cfg.storage.dbPath), 'media'))

  // 4b. Migración v2: la sesión única vieja pasa a ser la primera cuenta
  importLegacySessionIfNeeded(authRoot, cfg.bot.phone ?? '')

  // 5. Conectar todas las cuentas que tengan sesión guardada
  await startAllSavedAccounts()

  // 6. Arrancar el scheduler de publicaciones programadas
  startScheduler(async (accountId, jids, text, decorations, adminId, scheduleId, mediaId) => {
    const r = await executeAndLog({
      adminId,
      accountId,
      targetJids: jids,
      text,
      decorations: decorations ?? null,
      scheduleId,
      mediaId: mediaId ?? null
    })
    return { sent: r.sent, failed: r.failed }
  })

  // 7. Banner con stats (al conectar la primera cuenta, o fallback a los 10s)
  setAccountReadyCallback(() => {
    printBanner(currentStats(webUrl))
  })
  setTimeout(() => {
    printBanner(currentStats(webUrl))
  }, 10_000)

  const shutdown = async (signal: string) => {
    log.info('Señal ' + signal + ' — cerrando…')
    stopScheduler()
    await stopAllAccounts()
    await stopWebServer()
    closeDatabase()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  log.error({ err }, 'Error fatal en main')
  process.exit(1)
})
