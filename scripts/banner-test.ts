/**
 * Test del banner ASCII del usuario + que se imprime UNA sola vez.
 */
import { logger } from '../lib/logger.ts'
import { silenceConsoleNoise } from '../lib/consoleFilter.ts'

silenceConsoleNoise()

const CYAN = '\x1b[36m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

let bannerAlreadyPrinted = false

function printBanner(opts: {
  phone: string
  sessionActive: boolean
  adminGroupsCount: number
  totalGroupsCount: number
  adminChannelsCount: number
  totalChannelsCount: number
  webUrl: string | null
}): void {
  if (bannerAlreadyPrinted) {
    console.log('--- NO imprimiendo banner (ya fue impreso) ---')
    return
  }
  bannerAlreadyPrinted = true

  const { phone, sessionActive, adminGroupsCount, totalGroupsCount, adminChannelsCount, totalChannelsCount, webUrl } = opts

  const lines: string[] = []
  lines.push('.----------------------------------------------------------.')
  lines.push('|░█▀█░█░█░█▀▄░█░░░▀█▀░█▀▀░█░█░░░█▄█░█▀█░█▀█░█▀█░█▀▀░█▀▀░█▀▄|')
  lines.push('|░█▀▀░█░█░█▀▄░█░░░░█░░▀▀█░█▀█░░░█░█░█▀█░█░█░█▀█░█░█░█▀▀░█▀▄|')
  lines.push('|░▀░░░▀▀▀░▀▀░░▀▀▀░▀▀▀░▀▀▀░▀░▀░░░▀░▀░▀░▀░▀░▀░▀░▀░▀▀▀░▀▀▀░▀░▀|')
  lines.push("'----------------------------------------------------------'")
  lines.push('')

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

console.log('=== TEST 1: Primera llamada al banner ===\n')
printBanner({
  phone: '5356795360',
  sessionActive: true,
  adminGroupsCount: 12,
  totalGroupsCount: 24,
  adminChannelsCount: 1,
  totalChannelsCount: 23,
  webUrl: 'http://localhost:3000'
})

console.log('=== TEST 2: Segunda llamada al banner (NO debe imprimirse) ===\n')
printBanner({
  phone: '5356795360',
  sessionActive: true,
  adminGroupsCount: 12,
  totalGroupsCount: 24,
  adminChannelsCount: 1,
  totalChannelsCount: 23,
  webUrl: 'http://localhost:3000'
})

console.log('=== TEST 3: Log de publicación debe ser compacto ===\n')
const log = logger('routes:publish')
log.info({ targets: 1, hasDecorations: true, batchId: 1 }, 'Iniciando publicación.')

const cLog = logger('client')
cLog.info({ jid: '120363429245644094@g.us', messageId: '3EB05B6370B0421C14CFCC' }, '✓ Enviado')
cLog.info('Broadcast finalizado: 1/1 enviados correctamente.')
log.info({ sent: 1, failed: 0, total: 1, batchId: 1 }, 'Publicación completada.')

console.log('\n=== TEST 4: Reconexión (debe ser silenciosa) ===\n')
cLog.debug('Sesión existente en "./data/auth", reconectando...')
cLog.debug('baileys v2.3000.1043857760 (latest=true) | método: sesión existente')
cLog.info('Reconectado.')

console.log('\n✅ Test completo')
