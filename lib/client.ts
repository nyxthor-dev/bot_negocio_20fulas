import makeWASocket, {
  type WASocket,
  type ConnectionState,
  type AuthenticationState,
  DisconnectReason,
  useMultiFileAuthState,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion,
  proto,
  type GroupMetadata,
  type AnyMessageContent
} from '@fer2809fl/baileys'
import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import pino from 'pino'
import QRCode from 'qrcode'
import qrTerminal from 'qrcode-terminal'
import { promises as fsPromises, existsSync, rmSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { logger } from './logger.ts'
import { delay, isGroup, isChannel } from './utils.ts'
import { attachDeliveryWatchers, awaitDelivery, sendWithUploadRetry } from './delivery.ts'
import { updateAccountStatus, touchAccountConnected, listAccounts } from './db.ts'

const log = logger('client')

export type PairingMethod = 'qr' | 'code'

export type AccountStatus = 'pending' | 'linking' | 'connected' | 'disconnected' | 'logged_out'

/**
 * Estado en memoria de cada cuenta WhatsApp. Varios runtimes viven a la vez,
 * uno por cuenta vinculada, cada uno con su socket y su carpeta de sesión.
 */
export interface AccountRuntime {
  accountId: number
  phone: string
  status: AccountStatus
  sock: WASocket | null
  /** Último QR recibido durante una vinculación (string crudo). */
  qr: string | null
  /** QR renderizado como data URL PNG para mostrarlo en el panel. */
  qrDataUrl: string | null
  /** Último código de 8 dígitos si la vinculación es por código. */
  pairingCode: string | null
  lastEventAt: number
  reconnectAttempts: number
}

const runtimes = new Map<number, AccountRuntime>()

/** Carpeta raíz donde viven las sesiones (una subcarpeta por account_id). */
let AUTH_ROOT = path.resolve(process.cwd(), 'data', 'auth')

export function configureAuthRoot(folder: string): void {
  AUTH_ROOT = path.resolve(folder)
}

function authFolderFor(accountId: number): string {
  return path.join(AUTH_ROOT, String(accountId))
}

let shuttingDown = false

const MAX_RECONNECT_DELAY_MS = 30_000

const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60, useClones: false })

const MAX_STORED_MESSAGES = 5000
const messageStore = new Map<string, proto.IMessage>()

/**
 * El upload de multimedia sale por HTTPS a los hosts de WhatsApp, no por el
 * websocket. Fuerzo IPv4 en el agente porque hay redes/VPS donde la ruta IPv6
 * está rota y las subidas fallan en todos los hosts.
 */
const mediaUploadAgent = new https.Agent({ keepAlive: true, family: 4 })

function rememberMessage(id: string | null | undefined, message: proto.IMessage | null | undefined): void {
  if (!id || !message) return
  if (messageStore.size >= MAX_STORED_MESSAGES) {
    const oldestKey = messageStore.keys().next().value
    if (oldestKey) messageStore.delete(oldestKey)
  }
  messageStore.set(id, message)
}

let cachedVersion: { version: [number, number, number]; isLatest: boolean } | null = null
async function getBaileysVersion(): Promise<{ version: [number, number, number]; isLatest: boolean }> {
  if (!cachedVersion) {
    cachedVersion = await fetchLatestBaileysVersion()
  }
  return cachedVersion
}

// ---------------------------------------------------------------------------
// Auth state helpers — patrón "in-memory durante vinculación, persist después".
// ---------------------------------------------------------------------------

type MemoryKeyStore = Map<string, unknown>

interface InFlightLink {
  state: AuthenticationState
  keys: MemoryKeyStore
}

/** Sesiones a medio vincular en este proceso (aún no escritas a disco). */
const inFlightLinks = new Map<number, InFlightLink>()

function createInMemoryAuthState(): { state: AuthenticationState; keys: MemoryKeyStore } {
  const creds = initAuthCreds()
  const keys: MemoryKeyStore = new Map()

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result: Record<string, unknown> = {}
        for (const id of ids) {
          const value = keys.get(`${type}:${id}`)
          if (value !== undefined) result[id] = value
        }
        return result as never
      },
      set: async (data) => {
        for (const type of Object.keys(data)) {
          const entries = (data as Record<string, Record<string, unknown>>)[type]
          for (const id of Object.keys(entries)) {
            const value = entries[id]
            const key = `${type}:${id}`
            if (value) keys.set(key, value)
            else keys.delete(key)
          }
        }
      }
    }
  }

  return { state, keys }
}

function fixFileName(file: string): string {
  return file.replace(/\//g, '__').replace(/:/g, '-')
}

async function persistAuthStateToDisk(
  folder: string,
  creds: AuthenticationState['creds'],
  keys: MemoryKeyStore
): Promise<void> {
  await fsPromises.mkdir(folder, { recursive: true })
  await fsPromises.writeFile(
    path.join(folder, 'creds.json'),
    JSON.stringify(creds, BufferJSON.replacer, 2)
  )
  for (const [combinedKey, value] of keys) {
    const sep = combinedKey.indexOf(':')
    const type = combinedKey.slice(0, sep)
    const id = combinedKey.slice(sep + 1)
    const fileName = fixFileName(`${type}-${id}.json`)
    await fsPromises.writeFile(path.join(folder, fileName), JSON.stringify(value, BufferJSON.replacer))
  }
}

export function hasSavedSession(accountId: number): boolean {
  return existsSync(path.join(authFolderFor(accountId), 'creds.json'))
}

/* ---------- Runtime helpers ---------- */

function getOrCreateRuntime(accountId: number, phone: string): AccountRuntime {
  let runtime = runtimes.get(accountId)
  if (!runtime) {
    runtime = {
      accountId,
      phone: phone ?? '',
      status: 'pending',
      sock: null,
      qr: null,
      qrDataUrl: null,
      pairingCode: null,
      lastEventAt: Date.now(),
      reconnectAttempts: 0
    }
    runtimes.set(accountId, runtime)
  }
  if (phone) runtime.phone = phone
  return runtime
}

function setRuntimeStatus(runtime: AccountRuntime, status: AccountStatus): void {
  runtime.status = status
  runtime.lastEventAt = Date.now()
  updateAccountStatus(runtime.accountId, status)
}

async function storeQr(runtime: AccountRuntime, qr: string): Promise<void> {
  runtime.qr = qr
  runtime.lastEventAt = Date.now()
  try {
    runtime.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 })
  } catch {
    runtime.qrDataUrl = null
  }
  // También lo tiramos a consola por si se vincula desde el server directamente
  log.info('QR listo para la cuenta ' + runtime.accountId + ' — también visible en el panel.')
  qrTerminal.generate(qr, { small: true }, (code) => {
    process.stdout.write('\n' + code + '\n')
  })
}

/* ---------- Callback global cuando una cuenta queda lista ---------- */

let onAccountReady: ((accountId: number) => void) | null = null

/** Registra el callback que se dispara cada vez que una cuenta conecta (index.ts lo usa para el banner). */
export function setAccountReadyCallback(cb: (accountId: number) => void): void {
  onAccountReady = cb
}

/* ---------- Sincronización de grupos/canales por cuenta ---------- */

export { normalizeJid, getBotJidVariants } from './groups.ts'
export { safeStr, extractChannelInfo, type ChannelInfo } from './newsletters.ts'

import {
  syncGroups as _syncGroups,
  type SyncGroupsResult
} from './groups.ts'
import {
  syncNewsletters as _syncNewsletters,
  type SyncNewslettersResult
} from './newsletters.ts'

/** Sincroniza grupos de la cuenta dada con la cache SQL. */
export async function syncGroups(accountId: number, cacheToDb: boolean = true): Promise<SyncGroupsResult> {
  const runtime = runtimes.get(accountId)
  if (!runtime?.sock) throw new Error('La cuenta ' + accountId + ' no está conectada.')
  return _syncGroups(runtime.sock, cacheToDb, accountId)
}

/** Sincroniza canales de la cuenta dada con la cache SQL. */
export async function syncNewsletters(accountId: number, cacheToDb: boolean = true): Promise<SyncNewslettersResult> {
  const runtime = runtimes.get(accountId)
  if (!runtime?.sock) throw new Error('La cuenta ' + accountId + ' no está conectada.')
  return _syncNewsletters(runtime.sock, cacheToDb, accountId)
}

async function syncAccountCaches(accountId: number, sock: WASocket): Promise<void> {
  try {
    const groupsResult = await _syncGroups(sock, true, accountId)
    await _syncNewsletters(sock, true, accountId)
    log.info(`Cuenta ${accountId}: ${groupsResult.adminGroups}/${groupsResult.totalGroups} grupos admin sincronizados.`)
  } catch (err) {
    log.warn({ err, accountId }, 'No se pudo sincronizar la caché de grupos de la cuenta.')
  }
}

/* ---------- Conexión del socket ---------- */

interface ConnectOpts {
  /** true cuando es una vinculación nueva (sin sesión en disco todavía). */
  freshLink: boolean
  /** Teléfono en formato internacional (para pedir código de vinculación). */
  phone?: string
  /** Método de vinculación para links nuevos: 'qr' o 'code'. */
  pairingMethod?: PairingMethod | null
}

async function connect(accountId: number, opts: ConnectOpts): Promise<AccountRuntime> {
  const runtime = getOrCreateRuntime(accountId, opts.phone ?? '')

  if (runtime.sock) {
    log.debug(`Cuenta ${accountId} ya tiene un socket activo, se ignora la llamada.`)
    return runtime
  }

  const authFolder = authFolderFor(accountId)

  let state: AuthenticationState
  let memoryKeys: MemoryKeyStore | null = null
  const saveCredsRef: { current: () => Promise<void> } = { current: async () => {} }

  const inFlight = inFlightLinks.get(accountId)
  if (inFlight) {
    // Vinculación arrancada en este mismo proceso que aún no terminó de registrar
    state = inFlight.state
    memoryKeys = inFlight.keys
    log.debug(`Cuenta ${accountId}: reintentando vinculación pendiente (en memoria).`)
  } else if (hasSavedSession(accountId)) {
    const loaded = await useMultiFileAuthState(authFolder)
    state = loaded.state
    saveCredsRef.current = loaded.saveCreds
    log.debug(`Cuenta ${accountId}: sesión existente en disco, reconectando...`)
  } else if (opts.freshLink) {
    const mem = createInMemoryAuthState()
    state = mem.state
    memoryKeys = mem.keys
    inFlightLinks.set(accountId, { state, keys: mem.keys })
    log.info(`Cuenta ${accountId}: sin sesión previa — iniciando vinculación nueva (en memoria).`)
  } else {
    throw new Error(`La cuenta ${accountId} no tiene sesión guardada. Vinculala primero desde el panel.`)
  }

  if (opts.freshLink) {
    setRuntimeStatus(runtime, 'linking')
  } else if (runtime.status !== 'connected') {
    setRuntimeStatus(runtime, 'disconnected')
  }

  const { version, isLatest } = await getBaileysVersion()
  log.debug(`Cuenta ${accountId}: baileys v${version.join('.')} (latest=${isLatest}).`)

  const baileysInternalLogger = pino({ level: 'silent' })

  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    msgRetryCounterCache,
    logger: baileysInternalLogger,
    generateHighQualityLinkPreview: true,
    fetchAgent: mediaUploadAgent,
    getMessage: async (key) => {
      if (!key.id) return undefined
      return messageStore.get(key.id)
    }
  }) as WASocket

  // Intercept sendMessage para guardar el mensaje saliente en el store.
  const originalSendMessage = sock.sendMessage.bind(sock)
  sock.sendMessage = async (jid, content, options) => {
    const sent = await originalSendMessage(jid, content, options)
    if (sent?.key?.id && sent?.message) {
      rememberMessage(sent.key.id, sent.message)
    }
    return sent
  }

  // Veredicto del servidor sobre cada mensaje enviado (ack crudo + updates)
  attachDeliveryWatchers(sock)

  runtime.sock = sock
  runtime.lastEventAt = Date.now()

  sock.ev.on('creds.update', () => {
    // Un fallo de disco/DB acá no puede tumbar el proceso: se loguea.
    saveCredsRef.current().catch(err => {
      log.error({ err, accountId }, 'Error persistiendo credenciales de sesión.')
    })
  })

  // Código de vinculación: se pide unos segundos después de abrir el socket
  if (opts.freshLink && opts.pairingMethod === 'code' && opts.phone) {
    const phone = opts.phone
    void (async () => {
      await delay(3000)
      try {
        const code = await sock.requestPairingCode(phone)
        runtime.pairingCode = code ?? null
        runtime.lastEventAt = Date.now()
        const formatted = code?.length === 8 ? code.slice(0, 4) + '-' + code.slice(4, 8) : code
        log.info(`Código de vinculación de la cuenta ${accountId}: ${formatted}`)
      } catch (err) {
        log.error({ err, accountId }, 'No se pudo obtener el código de vinculación.')
      }
    })()
  }

  sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
    try {
    const { connection, lastDisconnect, qr } = update

    if (qr && opts.freshLink) {
      await storeQr(runtime, qr)
    } else if (qr) {
      // QR con sesión supuestamente existente — raro, pero lo guardamos por si acaso
      await storeQr(runtime, qr)
    }

    if (update.isNewLogin) {
      log.info(`Cuenta ${accountId}: ¡dispositivo vinculado correctamente!`)
    }

    if (connection === 'open') {
      const isFirstConnect = runtime.reconnectAttempts === 0
      if (isFirstConnect) {
        log.info(`Cuenta ${accountId}: conectado como ${sock.user?.id ?? runtime.phone}`)
      } else {
        log.info(`Cuenta ${accountId}: reconectado.`)
      }
      runtime.reconnectAttempts = 0
      runtime.qr = null
      runtime.qrDataUrl = null
      runtime.pairingCode = null
      setRuntimeStatus(runtime, 'connected')
      touchAccountConnected(accountId)

      if (memoryKeys && state.creds.registered) {
        try {
          await persistAuthStateToDisk(authFolder, state.creds, memoryKeys)
          const loaded = await useMultiFileAuthState(authFolder)
          saveCredsRef.current = loaded.saveCreds
          inFlightLinks.delete(accountId)
          memoryKeys = null
          log.info(`Cuenta ${accountId}: sesión persistida en disco correctamente.`)
        } catch (err) {
          log.error({ err, accountId }, 'Error guardando sesión en disco, se reintentará en el próximo reconnect.')
        }
      } else if (inFlightLinks.has(accountId) && state.creds.registered) {
        // Ya hay sesión en disco pero quedó registro en memoria — limpiamos
        inFlightLinks.delete(accountId)
      }

      void syncAccountCaches(accountId, sock)
      onAccountReady?.(accountId)
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const reason = DisconnectReason[statusCode as number] ?? 'UNKNOWN'
      const loggedOut = statusCode === DisconnectReason.loggedOut

      log.warn(`Cuenta ${accountId}: conexión cerrada (código ${statusCode} — ${reason}).`)

      runtime.sock = null

      if (loggedOut) {
        log.error(`Cuenta ${accountId}: sesión cerrada desde el teléfono (loggedOut). Borra la cuenta del panel y volvé a vincularla.`)
        setRuntimeStatus(runtime, 'logged_out')
        inFlightLinks.delete(accountId)
        return
      }

      if (shuttingDown) return

      // Reintento con backoff exponencial
      const d = Math.min(1000 * 2 ** runtime.reconnectAttempts, MAX_RECONNECT_DELAY_MS)
      runtime.reconnectAttempts++
      setRuntimeStatus(runtime, 'disconnected')
      log.info(`Cuenta ${accountId}: reintentando en ${Math.round(d / 1000)}s...`)
      setTimeout(() => {
        void connect(accountId, { freshLink: false }).catch(err => {
          log.error({ err, accountId }, 'Error reconectando la cuenta.')
        })
      }, d)
    }
    } catch (err) {
      // El handler es async: un error acá sería una unhandled rejection que
      // (sin red de seguridad) mataría el proceso. Se loguea y se sigue.
      log.error({ err, accountId }, 'Error procesando connection.update.')
    }
  })

  // Mantener el store de mensajes aunque no despachemos a handler externo
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      if (m.key?.id && m.message) {
        rememberMessage(m.key.id, m.message)
      }
    }
  })

  return runtime
}

/* ---------- API pública del gestor de cuentas ---------- */

/** Conecta una cuenta que ya tiene sesión guardada en disco. */
export async function startAccount(accountId: number): Promise<AccountRuntime> {
  return connect(accountId, { freshLink: false })
}

/**
 * Inicia la vinculación de una cuenta nueva (QR o código).
 * El QR queda disponible vía getRuntime() para que el panel lo muestre.
 */
export async function linkAccount(
  accountId: number,
  phone: string,
  pairingMethod: PairingMethod = 'qr'
): Promise<AccountRuntime> {
  if (hasSavedSession(accountId)) {
    throw new Error('La cuenta ya tiene una sesión guardada. Usá reconectar.')
  }
  return connect(accountId, { freshLink: true, phone, pairingMethod })
}

/** Cancela una vinculación en curso (cierra el socket, la cuenta queda pendiente). */
export function cancelLink(accountId: number): void {
  const runtime = runtimes.get(accountId)
  inFlightLinks.delete(accountId)
  if (runtime?.sock) {
    try { runtime.sock.end(new Error('link-cancelled')) } catch { /* noop */ }
    runtime.sock = null
  }
  if (runtime) {
    runtime.qr = null
    runtime.qrDataUrl = null
    runtime.pairingCode = null
    setRuntimeStatus(runtime, 'pending')
  }
}

/** Estado actual del runtime de una cuenta (para el panel). */
export function getRuntime(accountId: number): AccountRuntime | undefined {
  return runtimes.get(accountId)
}

/**
 * Pide el código de 8 dígitos para vincular con número (en vez de QR).
 * Sólo tiene sentido durante una vinculación en curso.
 */
export async function requestPairingCodeFor(accountId: number): Promise<string> {
  const runtime = runtimes.get(accountId)
  if (!runtime || !runtime.sock) {
    throw new Error('La cuenta no está en proceso de vinculación.')
  }
  const code = await runtime.sock.requestPairingCode(runtime.phone)
  runtime.pairingCode = code ?? null
  runtime.lastEventAt = Date.now()
  const formatted = code?.length === 8 ? code.slice(0, 4) + '-' + code.slice(4, 8) : code
  log.info(`Código de vinculación de la cuenta ${accountId}: ${formatted}`)
  return formatted ?? ''
}

/** Conecta todas las cuentas que tengan sesión en disco (arranque del bot). */
export async function startAllSavedAccounts(): Promise<{ started: number; skipped: number }> {
  const accounts = listAccounts()
  let started = 0
  let skipped = 0
  for (const account of accounts) {
    if (hasSavedSession(account.id)) {
      try {
        await connect(account.id, { freshLink: false, phone: account.phone })
        started++
      } catch (err) {
        log.error({ err, accountId: account.id }, 'No se pudo arrancar la cuenta guardada.')
      }
    } else {
      skipped++
    }
  }
  log.info(`Cuentas arrancadas: ${started} (sin sesión guardada: ${skipped}).`)
  return { started, skipped }
}

/** Detiene una cuenta sin borrar su sesión. */
export async function stopAccount(accountId: number): Promise<void> {
  const runtime = runtimes.get(accountId)
  if (runtime?.sock) {
    log.info(`Cuenta ${accountId}: cerrando conexión…`)
    try { await runtime.sock.end(new Error('shutdown')) } catch { /* noop */ }
    runtime.sock = null
    setRuntimeStatus(runtime, 'disconnected')
  }
}

/** Desvincula la cuenta de WhatsApp (logout + borra sesión del disco). */
export async function unlinkAccount(accountId: number): Promise<void> {
  const runtime = runtimes.get(accountId)
  const sock = runtime?.sock ?? null
  if (runtime) runtime.sock = null
  try {
    if (sock) {
      await sock.logout()
    }
  } catch (err) {
    log.warn({ err, accountId }, 'logout() falló — se borra la sesión local igual.')
    try { sock?.end(new Error('unlink')) } catch { /* noop */ }
  }
  const folder = authFolderFor(accountId)
  if (existsSync(folder)) {
    rmSync(folder, { recursive: true, force: true })
  }
  inFlightLinks.delete(accountId)
  if (runtime) {
    runtime.qr = null
    runtime.qrDataUrl = null
    runtime.pairingCode = null
    setRuntimeStatus(runtime, 'logged_out')
  }
  log.info(`Cuenta ${accountId}: desvinculada y sesión borrada del disco.`)
}

/** Limpieza total al eliminar una cuenta del panel. */
export async function cleanupAccount(accountId: number): Promise<void> {
  await unlinkAccount(accountId)
  runtimes.delete(accountId)
}

/** Detiene todas las cuentas (apagado ordenado del proceso). */
export async function stopAllAccounts(): Promise<void> {
  shuttingDown = true
  for (const runtime of runtimes.values()) {
    if (runtime.sock) {
      try { await runtime.sock.end(new Error('shutdown')) } catch { /* noop */ }
      runtime.sock = null
    }
  }
}

/** ¿La cuenta tiene socket vivo y estado conectado? */
export function isAccountConnected(accountId: number): boolean {
  const runtime = runtimes.get(accountId)
  return !!runtime?.sock && runtime.status === 'connected'
}

/* ---------- Envío de mensajes ---------- */

/**
 * Límite de tiempo por sendMessage (websocket zombie, red colgada, etc.).
 * Sin esto, un único envío colgado congela TODO el scheduler y los envíos
 * del panel: los ticks siguen pero el await no avanza nunca.
 */
const SEND_TIMEOUT_MS = 60_000

/** Corre la promesa con deadline. Si el timeout gana, se rechaza con error claro. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} (${Math.round(ms / 1000)}s)`)), ms)
  })
  return Promise.race([
    // El catch/rethrow mantiene la promesa original atada a la carrera: si el
    // timeout gana primero, su rechazo tardío igual queda "manejado".
    p.then(v => v, err => { throw err }),
    timeout
  ]).finally(() => clearTimeout(timer!))
}

/**
 * Broadcast a múltiples JIDs usando la cuenta indicada.
 * Devuelve resultados individuales por destino.
 *
 * @param accountId    Cuenta que envía (debe estar conectada)
 * @param jids         Lista de JIDs destino
 * @param messages     Mensaje(s) ya construido(s) — uno, o varios que van
 *                     juntos al mismo destino (ej: audio + texto)
 * @param delayMs      Delay base entre destinos (anti-flood). Se le suma jitter aleatorio. Default: 1500ms.
 */
export async function broadcastToAccount(
  accountId: number,
  jids: string[],
  messages: AnyMessageContent | AnyMessageContent[],
  delayMs: number = 1500
): Promise<Array<{ jid: string; success: boolean; messageId?: string; error?: string }>> {
  const results: Array<{ jid: string; success: boolean; messageId?: string; error?: string }> = []

  const runtime = runtimes.get(accountId)
  const sock = runtime?.sock ?? null

  if (!sock || runtime?.status !== 'connected') {
    const error = 'La cuenta no está conectada'
    log.warn({ accountId }, 'Broadcast omitido: ' + error + '.')
    return jids.map(jid => ({ jid, success: false, error }))
  }

  const msgList: AnyMessageContent[] = Array.isArray(messages) ? messages : [messages]

  log.info(`Cuenta ${accountId}: broadcast a ${jids.length} destino(s), ${msgList.length} mensaje(s) por destino.`)

  for (const jid of jids) {
    if (!isGroup(jid) && !isChannel(jid)) {
      log.warn({ jid, accountId }, 'JID no es grupo ni canal, se omite.')
      results.push({ jid, success: false, error: 'JID no es grupo ni canal' })
      continue
    }

    try {
      const sentIds: string[] = []
      for (const message of msgList) {
        const sent = await withTimeout(sendWithUploadRetry(sock, jid, message), SEND_TIMEOUT_MS, `Timeout enviando a ${jid}`)
        if (sent?.key?.id) sentIds.push(sent.key.id)
      }

      if (sentIds.length === 0) {
        // Ningún envío devolvió id de mensaje: no hay forma de confirmar que
        // haya salido. Se marca como fallo (antes se reportaba "✓ Enviado"
        // sin haber confirmación, contaminando el historial).
        results.push({ jid, success: false, error: 'sin confirmación de envío' })
        log.warn({ jid }, 'El envío no devolvió id de mensaje')
      } else {
        const isAlive = () => runtime.status === 'connected' && runtime.sock === sock
        const verdict = await awaitDelivery(sentIds, isChannel(jid), isAlive)
        const lastId = sentIds[sentIds.length - 1]
        if (verdict.ok) {
          results.push({ jid, success: true, messageId: lastId })
          log.info({ jid, messageId: lastId }, '✓ Enviado y confirmado por el servidor')
        } else {
          results.push({ jid, success: false, error: verdict.error ?? 'sin confirmación' })
          log.warn({ jid, error: verdict.error }, 'El servidor no aceptó el mensaje')
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, jid }, 'Error enviando mensaje')
      results.push({ jid, success: false, error: msg })
    }

    if (delayMs > 0 && jid !== jids[jids.length - 1]) {
      // Jitter para no mandar siempre al mismo ritmo exacto
      await delay(delayMs + Math.floor(Math.random() * 400))
    }
  }

  const okCount = results.filter(r => r.success).length
  log.info(`Cuenta ${accountId}: broadcast finalizado: ${okCount}/${jids.length} enviados correctamente.`)
  return results
}

/** Devuelve el socket de una cuenta conectada (para usos internos). */
export function getAccountSocket(accountId: number): WASocket {
  const runtime = runtimes.get(accountId)
  if (!runtime?.sock) {
    throw new Error('La cuenta ' + accountId + ' no está conectada todavía.')
  }
  return runtime.sock
}
