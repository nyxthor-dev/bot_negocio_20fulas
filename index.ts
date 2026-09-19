import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import qrTerminal from 'qrcode-terminal'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { startClient, type PairingMethod } from './lib/client.ts'
import { loadConfig, type BotConfig } from './lib/config.ts'
import { openDatabase, closeDatabase, getAdminGroups as getCachedAdminGroups } from './lib/db.ts'
import { ensureAdminCredentials, printCredentialsBox } from './lib/adminAuth.ts'
import { silenceConsoleNoise } from './lib/consoleFilter.ts'
import { logger } from './lib/logger.ts'
import { isValidPhone, readPackageInfo } from './lib/utils.ts'
import { startWebServer, stopWebServer } from './web/server.ts'

const log = logger('index')

silenceConsoleNoise()

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

// Flags globales: el banner se imprime UNA sola vez en toda la vida del proceso,
// y la sincronización inicial se hace UNA sola vez (las reconexiones no la
// re-disparan, eso se hace vía el botón "Sincronizar" del panel si hace falta).
let bannerAlreadyPrinted = false
let initialSyncDone = false

/**
 * Banner ASCII del usuario.
 * Debajo: stats compactas en una sola línea.
 */
function printBanner(opts: {
  phone: string
  sessionActive: boolean
  adminGroupsCount: number
  totalGroupsCount: number
  adminChannelsCount: number
  totalChannelsCount: number
  webUrl: string | null
}): void {
  if (bannerAlreadyPrinted) return
  bannerAlreadyPrinted = true

  const { phone, sessionActive, adminGroupsCount, totalGroupsCount, adminChannelsCount, totalChannelsCount, webUrl } = opts

  const lines: string[] = []
  // Banner ASCII arte del usuario
  lines.push('.----------------------------------------------------------.')
  lines.push('|░█▀█░█░█░█▀▄░█░░░▀█▀░█▀▀░█░█░░░█▄█░█▀█░█▀█░█▀█░█▀▀░█▀▀░█▀▄|')
  lines.push('|░█▀▀░█░█░█▀▄░█░░░░█░░▀▀█░█▀█░░░█░█░█▀█░█░█░█▀█░█░█░█▀▀░█▀▄|')
  lines.push('|░▀░░░▀▀▀░▀▀░░▀▀▀░▀▀▀░▀▀▀░▀░▀░░░▀░▀░▀░▀░▀░▀░▀░▀░▀▀▀░▀▀▀░▀░▀|')
  lines.push("'----------------------------------------------------------'")
  lines.push('')

  // Stats compactas en una sola línea
  const sessionIcon = sessionActive ? GREEN + '✓' + RESET : YELLOW + '○' + RESET
  const sessionPart = `${sessionIcon} ${DIM}Sesión${RESET} ${CYAN}${phone}${RESET}`
  const groupsPart = `${DIM}Grupos${RESET} ${GREEN}${adminGroupsCount}${RESET}${DIM}/${RESET}${totalGroupsCount}`
  const channelsPart = `${DIM}Canales${RESET} ${GREEN}${adminChannelsCount}${RESET}${DIM}/${RESET}${totalChannelsCount}`
  const webPart = webUrl
    ? `${DIM}Panel${RESET} ${CYAN}${webUrl}${RESET}`
    : `${DIM}Panel${RESET} ${YELLOW}off${RESET}`

  process.stdout.write(lines.join('\n') + '\n')
  process.stdout.write(`  ${sessionPart}  ${groupsPart}  ${channelsPart}  ${webPart}\n\n`)
}

async function resolvePhone(cfg: BotConfig): Promise<string> {
  const fromConfig = cfg.bot.phone?.trim()
  if (fromConfig && isValidPhone(fromConfig)) return fromConfig

  if (!process.stdin.isTTY) {
    log.error('bot.phone no configurado y no hay TTY para pedirlo.')
    log.error('Configurá bot.phone en config.json.')
    process.exit(1)
  }

  const rl = createInterface({ input, output })
  try {
    let phone = ''
    while (!isValidPhone(phone)) {
      phone = (await rl.question(
        'Número a vincular (formato internacional, ej: 5491112345678):\n> '
      )).trim()
      if (!isValidPhone(phone)) {
        output.write('Número inválido (7-15 dígitos, sin + ni espacios).\n')
      }
    }
    return phone
  } finally {
    rl.close()
  }
}

async function resolvePairingMethod(cfg: BotConfig): Promise<PairingMethod> {
  const fromConfig = cfg.bot.pairingMethod
  if (fromConfig === 'qr' || fromConfig === 'code') return fromConfig
  return 'qr'
}

function printPairingCodeBox(formatted: string): void {
  const lines = [
    '',
    '╔════════════════════════════════════════════════════╗',
    '║   CÓDIGO DE VINCULACIÓN:  ' + formatted + '              ║',
    '╚════════════════════════════════════════════════════╝',
    '',
    '>> A tu teléfono debería llegarle una notificación push de WhatsApp.',
    '>> O manualmente: WhatsApp > Dispositivos vinculados > Vincular un dispositivo > Vincular con número.',
    '>> Ingresá el código: ' + formatted,
    ''
  ]
  output.write(lines.join('\n') + '\n')
}

async function main(): Promise<void> {
  clearConsole()
  const cfg = loadConfig()
  process.env.LOG_LEVEL = cfg.logging.level

  const pkg = readPackageInfo()

  // 1. Abrir SQLite
  openDatabase(cfg.storage.dbPath)

  // 2. Bootstrap credenciales admin
  const adminCreds = ensureAdminCredentials()
  if (adminCreds) {
    printCredentialsBox(adminCreds)
  }

  // 3. Arrancar el panel web INMEDIATAMENTE
  let webUrl: string | null = null
  if (cfg.web.enabled) {
    try {
      const result = await startWebServer({ host: cfg.web.host, port: cfg.web.port })
      webUrl = result.url
    } catch (err) {
      log.error({ err }, 'No se pudo arrancar el panel web.')
    }
  }

  // 4. Resolver teléfono
  const phone = await resolvePhone(cfg)

  // 5. Resolver authFolder
  const authFolder = resolve(__dirname, cfg.storage.authFolder)

  // 6. Determinar método de vinculación
  const hasSession = existsSync(join(authFolder, 'creds.json'))
  const pairingMethod: PairingMethod | null = hasSession
    ? null
    : await resolvePairingMethod(cfg)

  // 7. Arrancar socket baileys
  await startClient({
    phone,
    authFolder,
    pairingMethod,
    onQR: (qr) => {
      log.info('Escaneá este QR desde WhatsApp > Dispositivos vinculados:')
      qrTerminal.generate(qr, { small: true }, (code) => {
        output.write('\n' + code + '\n')
      })
    },
    onPairingCode: (code) => {
      const formatted = code.length === 8
        ? code.slice(0, 4) + '-' + code.slice(4, 8)
        : code
      printPairingCodeBox(formatted)
    },
    onReady: async (sock) => {
      // Sincronizar grupos/canales.
      // Si la sync inicial ya terminó con éxito, no repetir (el usuario puede
      // forzarla desde el panel). Pero si la sync inicial falló (conexión caída
      // a mitad), re-intentar en la próxima reconexión.
      if (initialSyncDone) {
        log.debug('Reconectado — la sincronización inicial ya se hizo.')
        return
      }

      // Pequeña espera para que la conexión se estabilice (evitar race conditions)
      await new Promise(r => setTimeout(r, 1500))

      try {
        const groupsResult = await (await import('./lib/client.ts')).syncGroups(true)
        const newslettersResult = await (await import('./lib/client.ts')).syncNewsletters(true)

        // Si detectamos al menos 1 admin o 0 grupos totales (sin grupos donde participa),
        // consideramos que la sincronización fue exitosa.
        // Si hay grupos pero 0 admin, podría ser que la sync se cortó a mitad
        // — en ese caso, marcamos initialSyncDone=false para re-intentar en reconexión.
        if (groupsResult.totalGroups > 0 && groupsResult.adminGroups === 0) {
          log.warn(`Sync inicial detectó 0 admin en ${groupsResult.totalGroups} grupos — re-intentando en próxima reconexión.`)
          // No marcamos initialSyncDone, así que la próxima reconexión lo re-intenta
        } else {
          initialSyncDone = true
        }

        // Si la primera sync fue exitosa y el banner aún no se imprimió, hacerlo
        if (!bannerAlreadyPrinted) {
          printBanner({
            phone,
            sessionActive: true,
            adminGroupsCount: groupsResult.adminGroups,
            totalGroupsCount: groupsResult.totalGroups,
            adminChannelsCount: newslettersResult.adminCount,
            totalChannelsCount: newslettersResult.total,
            webUrl
          })
        }
      } catch (err) {
        log.warn({ err }, 'No se pudo sincronizar grupos al cache.')
        // No marcamos initialSyncDone — la próxima reconexión lo re-intenta
        // Aun así imprimir el banner la primera vez
        if (!bannerAlreadyPrinted) {
          printBanner({
            phone,
            sessionActive: true,
            adminGroupsCount: 0,
            totalGroupsCount: 0,
            adminChannelsCount: 0,
            totalChannelsCount: 0,
            webUrl
          })
        }
      }
      void sock // sock unused
    }
  })

  const shutdown = async (signal: string) => {
    log.info('Señal ' + signal + ' — cerrando…')
    await stopWebServer()
    const { stopClient } = await import('./lib/client.ts')
    await stopClient()
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
