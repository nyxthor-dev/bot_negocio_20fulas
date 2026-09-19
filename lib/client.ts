import makeWASocket, {
  type WASocket,
  type BaileysEventMap,
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
import { promises as fsPromises, existsSync } from 'node:fs'
import path from 'node:path'
import { logger } from './logger.ts'
import { delay, isGroup, isChannel } from './utils.ts'

const log = logger('client')

export type PairingMethod = 'qr' | 'code'

export interface StartClientOptions {
  /** Número de teléfono en formato internacional sin + ni espacios. */
  phone: string
  /** Carpeta donde se guardan las credenciales (multi-file JSON). */
  authFolder: string
  /** Método de vinculación: 'qr' o 'code'. null = hay sesión existente. */
  pairingMethod?: PairingMethod | null
  /** Callback que recibe el QR string a renderizar en consola u otro medio. */
  onQR?: (qr: string) => void
  /** Callback que recibe el código de vinculación de 8 dígitos. */
  onPairingCode?: (code: string) => void
  /** Callback cuando la conexión queda lista (open). */
  onReady?: (sock: WASocket) => void
  /** Callback cuando cambia el estado de conexión (para diagnóstico). */
  onConnectionUpdate?: (update: Partial<ConnectionState>) => void
  /** Reconectar automáticamente al perder la conexión. Default: true. */
  autoReconnect?: boolean
}

let sockSingleton: WASocket | null = null

// ---------------------------------------------------------------------------
// Auth state helpers — patrón "in-memory durante pairing, persist después".
// ---------------------------------------------------------------------------

type MemoryKeyStore = Map<string, unknown>

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

function hasExistingSession(folder: string): boolean {
  return existsSync(path.join(folder, 'creds.json'))
}

let persistedState: AuthenticationState | null = null
let persistedMemoryKeys: MemoryKeyStore | null = null

let reconnectAttempts = 0
const MAX_RECONNECT_DELAY_MS = 30_000
function getReconnectDelay(): number {
  const d = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS)
  reconnectAttempts++
  return d
}

const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60, useClones: false })

const MAX_STORED_MESSAGES = 5000
const messageStore = new Map<string, proto.IMessage>()

function rememberMessage(id: string | null | undefined, message: proto.IMessage | null | undefined): void {
  if (!id || !message) return
  if (messageStore.size >= MAX_STORED_MESSAGES) {
    const oldestKey = messageStore.keys().next().value
    if (oldestKey) messageStore.delete(oldestKey)
  }
  messageStore.set(id, message)
}

/* ---------- Funciones públicas: publicación a grupos/canales ---------- */

// Re-exportamos tipos y utilidades puras (que no requieren socket) desde los módulos.
export { normalizeJid, getBotJidVariants } from './groups.ts'
export { safeStr, extractChannelInfo, type ChannelInfo } from './newsletters.ts'

import {
  fetchAllGroups as _fetchAllGroups,
  isBotAdminOfGroup as _isBotAdminOfGroup,
  isBotOwnerOfGroup as _isBotOwnerOfGroup,
  syncGroups as _syncGroups,
  type SyncGroupsResult
} from './groups.ts'
import {
  fetchSubscribedNewsletters as _fetchSubscribedNewsletters,
  syncNewsletters as _syncNewsletters,
  fetchAdminNewsletters as _fetchAdminNewsletters,
  type SyncNewslettersResult
} from './newsletters.ts'

/** Obtiene todos los grupos donde participa el bot. */
export async function fetchAllGroups(): Promise<import('@fer2809fl/baileys').GroupMetadata[]> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')
  return _fetchAllGroups(sockSingleton)
}

/** Devuelve true si el bot es admin del grupo dado. */
export async function isBotAdminOfGroup(g: import('@fer2809fl/baileys').GroupMetadata): Promise<boolean> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')
  return _isBotAdminOfGroup(sockSingleton, g)
}

/** Devuelve true si el bot es superadmin (owner) del grupo dado. */
export async function isBotOwnerOfGroup(g: import('@fer2809fl/baileys').GroupMetadata): Promise<boolean> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')
  return _isBotOwnerOfGroup(sockSingleton, g)
}

/** Obtiene todos los canales suscritos. */
export async function fetchSubscribedNewsletters(): Promise<unknown[]> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')
  return _fetchSubscribedNewsletters(sockSingleton)
}

/** Devuelve lista de canales donde el bot es admin (fetch en vivo). */
export async function fetchAdminNewsletters(): Promise<import('./newsletters.ts').ChannelInfo[]> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')
  return _fetchAdminNewsletters(sockSingleton)
}

/**
 * Sincroniza tanto grupos como canales con la cache SQL.
 * Devuelve la lista de grupos admin (para compatibilidad con código existente).
 */
export async function getAdminGroups(cacheToDb: boolean = true): Promise<import('@fer2809fl/baileys').GroupMetadata[]> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')

  const groupsResult = await _syncGroups(sockSingleton, cacheToDb)
  await _syncNewsletters(sockSingleton, cacheToDb)

  return groupsResult.adminGroupsList
}

/** Sincroniza sólo grupos. */
export async function syncGroups(cacheToDb: boolean = true): Promise<SyncGroupsResult> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')
  return _syncGroups(sockSingleton, cacheToDb)
}

/** Sincroniza sólo canales. */
export async function syncNewsletters(cacheToDb: boolean = true): Promise<SyncNewslettersResult> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')
  return _syncNewsletters(sockSingleton, cacheToDb)
}

/**
 * Envía un mensaje a un JID específico (grupo, canal o DM).
 *
 * Implementa retry automático para errores conocidos de baileys como
 * "Media upload failed on all hosts" (suele ser transitorio).
 *
 * @param jid           Destino
 * @param message       Mensaje ya construido
 * @param maxRetries    Cantidad máxima de reintentos (default: 2)
 */
export async function sendToTarget(
  jid: string,
  message: AnyMessageContent,
  maxRetries: number = 2
): Promise<{ jid: string; success: boolean; messageId?: string; error?: string }> {
  if (!sockSingleton) throw new Error('Socket no inicializado.')

  let lastErr: string | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sent = await sockSingleton.sendMessage(jid, message)
      if (attempt > 0) {
        log.info({ jid, attempt: attempt + 1 }, '✓ Enviado (tras retry)')
      }
      return {
        jid,
        success: true,
        messageId: sent?.key?.id
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)

      // Errores transitorios conocidos que vale la pena reintentar:
      //   - "Media upload failed on all hosts" (subida de media falló en todos los hosts)
      //   - "Connection Closed" (conexión se cerró temporalmente)
      //   - "Timed Out" (timeout de red)
      const isTransient = /media upload failed|connection closed|timed out|ETIMEDOUT|ENOTFOUND|ECONNRESET/i.test(lastErr)

      if (attempt < maxRetries && isTransient) {
        const waitMs = 2000 * (attempt + 1)  // 2s, 4s
        log.warn({ jid, attempt: attempt + 1, waitMs, err: lastErr }, 'Reintentando envío...')
        await delay(waitMs)
        continue
      }

      log.error({ err: lastErr, jid }, 'Error enviando mensaje (sin más reintentos)')
      return { jid, success: false, error: lastErr }
    }
  }

  return { jid, success: false, error: lastErr ?? 'unknown error' }
}

/**
 * Broadcast: envía el mismo mensaje a múltiples JIDs.
 * Devuelve resultados individuales por destino.
 *
 * @param jids         Lista de JIDs destino
 * @param message      Mensaje ya construido (AnyMessageContent)
 * @param delayMs      Delay entre envíos (anti-flood). Default: 1500ms.
 */
export async function broadcastToTargets(
  jids: string[],
  message: AnyMessageContent,
  delayMs: number = 1500
): Promise<Array<{ jid: string; success: boolean; messageId?: string; error?: string }>> {
  const results: Array<{ jid: string; success: boolean; messageId?: string; error?: string }> = []
  log.info(`Iniciando broadcast a ${jids.length} destino(s)...`)

  for (const jid of jids) {
    if (!isGroup(jid) && !isChannel(jid)) {
      log.warn({ jid }, 'JID no es grupo ni canal, se omite.')
      results.push({ jid, success: false, error: 'JID no es grupo ni canal' })
      continue
    }

    const result = await sendToTarget(jid, message)
    results.push(result)

    if (result.success) {
      log.info({ jid, messageId: result.messageId }, '✓ Enviado')
    } else {
      log.warn({ jid, error: result.error }, '✗ Falló')
    }

    if (delayMs > 0) {
      await delay(delayMs)
    }
  }

  const okCount = results.filter(r => r.success).length
  log.info(`Broadcast finalizado: ${okCount}/${jids.length} enviados correctamente.`)
  return results
}

/* ---------- Start / Stop del cliente ---------- */

/**
 * Inicia el socket de WhatsApp vinculado al número indicado.
 * Primera vez: genera QR o pairing code según el método elegido.
 * Reconexiones: carga la sesión existente de disco.
 */
export async function startClient(opts: StartClientOptions): Promise<WASocket> {
  const { phone, authFolder, pairingMethod = null } = opts
  const autoReconnect = opts.autoReconnect ?? true

  let state: AuthenticationState
  let memoryKeys: MemoryKeyStore | null = null
  const saveCredsRef: { current: () => Promise<void> } = { current: async () => {} }
  let alreadyLinked: boolean

  if (persistedState && persistedMemoryKeys) {
    state = persistedState
    memoryKeys = persistedMemoryKeys
    alreadyLinked = true
    log.debug('Reconectando con sesión recién vinculada (guardándose en disco)...')
  } else if (hasExistingSession(authFolder)) {
    const loaded = await useMultiFileAuthState(authFolder)
    state = loaded.state
    saveCredsRef.current = loaded.saveCreds
    alreadyLinked = true
    log.debug(`Sesión existente en "${authFolder}", reconectando...`)
  } else {
    const mem = createInMemoryAuthState()
    state = mem.state
    memoryKeys = mem.keys
    alreadyLinked = false
    log.info('Sin sesión previa — empezando vinculación nueva (en memoria).')
  }

  persistedState = state
  persistedMemoryKeys = memoryKeys

  const { version, isLatest } = await fetchLatestBaileysVersion()
  const metodoLabel = pairingMethod === null
    ? 'sesión existente'
    : (pairingMethod === 'qr' ? 'QR' : 'código')
  log.debug(`baileys v${version.join('.')} (latest=${isLatest}) | método: ${metodoLabel}`)

  const baileysInternalLogger = pino({ level: 'silent' })

  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    msgRetryCounterCache,
    logger: baileysInternalLogger,
    generateHighQualityLinkPreview: true,
    getMessage: async (key) => {
      if (!key.id) return undefined
      return messageStore.get(key.id)
    }
  }) as WASocket

  // NOTA: NO interceptamos sendMessage como hace el otro bot.
  // El intercept anterior causaba overhead innecesario y podía interferir
  // con la subida de media. Si necesitás guardar mensajes salientes para
  // retry de descifrado, hacerlo en el evento messages.upsert (que ya
  // captura tanto entrantes como salientes).

  sockSingleton = sock

  sock.ev.on('creds.update', () => {
    void saveCredsRef.current()
  })

  if (!alreadyLinked && pairingMethod === 'code' && opts.onPairingCode) {
    void (async () => {
      await delay(3000)
      try {
        const code = await sock.requestPairingCode(phone)
        opts.onPairingCode!(code)
      } catch (err) {
        log.error({ err }, 'No se pudo obtener el código de vinculación.')
      }
    })()
  }

  sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update

    opts.onConnectionUpdate?.(update)

    if (qr && pairingMethod === 'qr' && opts.onQR) {
      opts.onQR(qr)
    }

    if (isNewLogin) {
      log.info('¡Dispositivo vinculado correctamente!')
    }

    if (connection === 'open') {
      // La primera vez es info, las siguientes son reconexiones — silenciosas.
      if (reconnectAttempts === 0) {
        log.info(`Conectado como ${sock.user?.id ?? phone}`)
      } else {
        log.info('Reconectado.')
      }
      reconnectAttempts = 0

      if (memoryKeys && state.creds.registered) {
        try {
          await persistAuthStateToDisk(authFolder, state.creds, memoryKeys)
          const loaded = await useMultiFileAuthState(authFolder)
          saveCredsRef.current = loaded.saveCreds
          memoryKeys = null
          persistedState = null
          persistedMemoryKeys = null
          log.info('Sesión persistida en disco correctamente.')
        } catch (err) {
          log.error({ err }, 'Error guardando sesión en disco, se reintentará en el próximo reconnect.')
        }
      }

      // NOTA: la sincronización de grupos/canales se hace en index.ts onReady
      // para que se ejecute una sola vez y no en cada reconexión.

      opts.onReady?.(sock)
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const reason = DisconnectReason[statusCode as number] ?? 'UNKNOWN'
      const shouldReconnect = autoReconnect && statusCode !== DisconnectReason.loggedOut

      log.warn(`Conexión cerrada (código ${statusCode} — ${reason}).`)

      if (shouldReconnect) {
        const d = getReconnectDelay()
        log.info(`Reintentando en ${Math.round(d / 1000)}s...`)
        setTimeout(() => { void startClient(opts) }, d)
      } else {
        log.error('Sesión cerrada (loggedOut). Borra la carpeta "' + authFolder + '" y volvé a vincular.')
        persistedState = null
        persistedMemoryKeys = null
        process.exit(1)
      }
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

  return sock
}

/** Devuelve el socket activo, si existe. */
export function getSocket(): WASocket {
  if (!sockSingleton) {
    throw new Error('El socket no está inicializado todavía. Llama a startClient primero.')
  }
  return sockSingleton
}

/** Cierra la conexión limpiamente. */
export async function stopClient(): Promise<void> {
  if (sockSingleton) {
    log.info('Cerrando conexión…')
    await sockSingleton.end(new Error('shutdown'))
    sockSingleton = null
  }
}
