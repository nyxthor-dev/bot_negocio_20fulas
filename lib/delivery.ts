/**
 * Confirmación de entrega de mensajes salientes.
 *
 * sendMessage() de baileys resuelve en cuanto el mensaje se escribe al
 * websocket, no cuando el servidor lo acepta. Si WhatsApp lo rechaza (ej:
 * grupo donde sólo escriben los admins), el fallo llega después como un ack
 * con error. Este módulo escucha esos acks, guarda el veredicto del servidor
 * por id de mensaje y permite esperar la confirmación real después de enviar.
 *
 * También reintentá la subida de multimedia cuando falla (renovando la
 * conexión de media), porque si la subida falló el mensaje nunca salió y
 * reintentar es seguro.
 */

import { proto, type WASocket, type AnyMessageContent } from '@fer2809fl/baileys'
import { delay } from './utils.ts'
import { logger } from './logger.ts'

const log = logger('delivery')

/** Timeout por host para la subida de multimedia (links lentos incluidos). */
const MEDIA_UPLOAD_TIMEOUT_MS = 90_000
/** Reintentos extra cuando falla la subida de multimedia. */
const MEDIA_UPLOAD_RETRIES = 2

export interface SendVerdict {
  ok: boolean
  error?: string
  ts: number
}

const sendVerdicts = new Map<string, SendVerdict>()
const MAX_VERDICTS = 5000

export function recordVerdict(id: string, verdict: Omit<SendVerdict, 'ts'>): void {
  if (sendVerdicts.size >= MAX_VERDICTS) {
    const oldest = sendVerdicts.keys().next().value
    if (oldest) sendVerdicts.delete(oldest)
  }
  sendVerdicts.set(id, { ...verdict, ts: Date.now() })
}

/** Códigos de error de ack más comunes -> texto humano. */
export function describeAckError(code: string): string {
  const clean = code.trim()
  if (clean === '403' || clean === '405') {
    return 'WhatsApp rechazó el mensaje (' + clean + ') — el destino restringe quién puede escribir.'
  }
  if (clean === '475') {
    return 'El mensaje no llegó a todos los dispositivos (' + clean + '), reintentá en unos minutos.'
  }
  if (clean === '408' || clean === '503') {
    return 'El servidor está saturado (' + clean + '), reintentá en unos minutos.'
  }
  return 'WhatsApp rechazó el mensaje (código ' + clean + ')'
}

/** Registra el veredicto de un nodo de ack crudo (ack class="message"). */
export function recordAckNode(node: { attrs?: Record<string, unknown> } | undefined | null): void {
  const attrs = node?.attrs ?? {}
  const id = attrs.id
  if (typeof id !== 'string' || !id) return
  const error = attrs.error
  if (error !== undefined && error !== null && error !== false && error !== '') {
    recordVerdict(id, { ok: false, error: describeAckError(String(error)) })
  } else {
    recordVerdict(id, { ok: true })
  }
}

/** Registra rechazos que llegan por updates de estado del mensaje. */
export function recordMessagesUpdate(updates: unknown): void {
  if (!Array.isArray(updates)) return
  for (const u of updates) {
    const key = (u as { key?: { id?: unknown; fromMe?: unknown } } | null)?.key
    const id = key?.id
    if (typeof id !== 'string' || !id || key?.fromMe !== true) continue
    const update = (u as { update?: { status?: unknown; messageStubParameters?: unknown } } | null)?.update
    if (update?.status !== proto.WebMessageInfo.Status.ERROR) continue
    const stub = update.messageStubParameters
    const detail = Array.isArray(stub) && stub.length > 0
      ? stub.filter(s => typeof s === 'string').join(' ')
      : ''
    recordVerdict(id, { ok: false, error: 'WhatsApp rechazó el mensaje' + (detail ? ' (' + detail + ')' : '') })
  }
}

/**
 * Engancha los listeners de veredicto a un socket (el crudo CB:ack del
 * websocket + el update de estado). Llamar apenas crear el socket.
 */
export function attachDeliveryWatchers(sock: WASocket): void {
  try {
    sock.ws.on('CB:ack,class:message', (node: { attrs?: Record<string, unknown> }) => {
      recordAckNode(node)
    })
  } catch {
    // si el ws interno no está expuesto en alguna versión, seguimos sin confirmación
  }
  sock.ev.on('messages.update', updates => {
    recordMessagesUpdate(updates)
  })
}

/**
 * Espera el veredicto del servidor para los ids enviados a un destino.
 * Si vence el plazo sin señal se reporta fallo (mejor avisar que dar por bueno
 * un envío que nunca prosperó). En canales el ack no siempre llega, así que
 * ahí el silencio no se toma como fallo.
 */
export async function awaitDelivery(
  ids: string[],
  isChannelDest: boolean,
  isAlive: () => boolean,
  waitMs: number = 8_000
): Promise<SendVerdict> {
  const deadline = Date.now() + waitMs
  while (true) {
    const verdicts = ids.map(id => sendVerdicts.get(id))
    const failed = verdicts.find(v => v && !v.ok)
    if (failed) return failed
    if (verdicts.length > 0 && verdicts.every(v => v?.ok)) {
      return { ok: true, ts: Date.now() }
    }
    if (!isAlive()) {
      return { ok: false, ts: Date.now(), error: 'La conexión se cerró durante el envío.' }
    }
    if (Date.now() >= deadline) {
      if (isChannelDest) return { ok: true, ts: Date.now() }
      return {
        ok: false,
        ts: Date.now(),
        error: 'El servidor nunca confirmó la entrega — el destino puede restringir quién escribe o la red falló.'
      }
    }
    await delay(100)
  }
}

/** Envía un mensaje reintentando la subida de multimedia si falla. */
export async function sendWithUploadRetry(
  sock: WASocket,
  jid: string,
  message: AnyMessageContent
): Promise<ReturnType<WASocket['sendMessage']>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sock.sendMessage(jid, message, { mediaUploadTimeoutMs: MEDIA_UPLOAD_TIMEOUT_MS })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isUploadFailure = /media upload failed|upload failed/i.test(msg)
      if (!isUploadFailure || attempt >= MEDIA_UPLOAD_RETRIES) throw err
      log.warn({ jid, attempt: attempt + 1 }, 'Falló la subida del multimedia, reintento con conexión de media renovada.')
      const sockExtras = sock as WASocket & {
        refreshMediaConn?: (forceGet?: boolean) => Promise<unknown>
      }
      if (typeof sockExtras.refreshMediaConn === 'function') {
        try { await sockExtras.refreshMediaConn(true) } catch { /* noop */ }
      }
      await delay(1500 * (attempt + 1))
    }
  }
}
