/**
 * Módulo de decoración de texto para mensajes salientes de WhatsApp.
 *
 * WhatsApp soporta varios tipos de decoración nativa:
 *  - Sintaxis markdown nativa: *negrita*, _cursiva_, ~tachado~, ||spoiler||, `mono`
 *  - contextInfo.isForwarded: muestra el tag "Reenviado" arriba del mensaje
 *  - contextInfo.forwardingScore: controla "Reenviado muchas veces"
 *  - contextInfo.mentionedJid: menciones @user
 *  - contextInfo.externalAdReply: preview de URL con imagen, título, descripción
 *
 * Este módulo expone una API declarativa: el panel web envía un objeto
 * DecorationOptions y nosotros devolvemos el payload listo para baileys.
 */

import type { AnyMessageContent, WAContextInfo } from '@fer2809fl/baileys'

/* ---------- Opciones declarativas (lo que el panel web envía) ---------- */

export interface MentionInput {
  /** Teléfono sin @s.whatsapp.net, ej: "5491112345678" */
  phone: string
  /** Nombre visible para mostrar en el texto (opcional) */
  name?: string
}

export interface LinkPreviewInput {
  url: string
  title?: string
  description?: string
  thumbnailUrl?: string  // http(s) URL de la miniatura
  sourceUrl?: string
  mediaType?: number
}

export interface DecorationOptions {
  /** Mostrar el tag "Reenviado" arriba del mensaje */
  forwarded?: boolean
  /**
   * Puntaje de reenvío. WhatsApp lo usa así:
   *  1-4: muestra "Reenviado"
   *  5+:  muestra "Reenviado muchas veces" (con icono doble)
   */
  forwardingScore?: number
  /** Lista de usuarios a mencionar en el mensaje */
  mentions?: MentionInput[]
  /** Preview de URL enriquecido (externo) */
  linkPreview?: LinkPreviewInput
  /**
   * Aplicar decoraciones markdown al texto automáticamente.
   * Si true, transforma: **bold** -> *bold*, __italic__ -> _italic_, etc.
   * Útil si el panel web usa markdown estándar en el textarea.
   */
  parseMarkdown?: boolean
}

/* ---------- Helpers internos ---------- */

/**
 * Convierte markdown estándar al formato de WhatsApp.
 * El panel puede usar markdown normal y nosotros lo adaptamos.
 *
 * NOTA: WhatsApp usa un único delimitador para cada estilo:
 *   *negrita*, _cursiva_, ~tachado~, ||spoiler||, ```mono```
 */
function convertMarkdown(text: string): string {
  // Negrita: **texto** -> *texto*
  let out = text.replace(/\*\*(.+?)\*\*/g, '*$1*')
  // Cursiva: __texto__ -> _texto_
  out = out.replace(/__(.+?)__/g, '_$1_')
  // Tachado: ~~texto~~ -> ~texto~
  out = out.replace(/~~(.+?)~~/g, '~$1~')
  // Spoiler: ||texto|| (WhatsApp ya lo usa así)
  // Mono: `codigo` (WhatsApp ya lo usa así) — no convertimos
  return out
}

/**
 * Construye el objeto WAContextInfo de baileys a partir de DecorationOptions.
 */
export function buildContextInfo(opts: DecorationOptions | undefined): WAContextInfo | undefined {
  if (!opts) return undefined

  const ctx: WAContextInfo = {}

  if (opts.forwarded) {
    ctx.isForwarded = true
    ctx.forwardingScore = opts.forwardingScore ?? 1
  }

  if (opts.mentions && opts.mentions.length > 0) {
    ctx.mentionedJid = opts.mentions.map(m => {
      const cleaned = m.phone.replace(/[^\d]/g, '')
      return `${cleaned}@s.whatsapp.net`
    })
  }

  if (opts.linkPreview) {
    const lp = opts.linkPreview
    ctx.externalAdReply = {
      title: lp.title ?? '',
      body: lp.description ?? '',
      mediaType: lp.mediaType ?? 1,
      thumbnailUrl: lp.thumbnailUrl,
      sourceUrl: lp.sourceUrl ?? lp.url,
      renderLargerThumbnail: false,
      showAdAttribution: false
    } as WAContextInfo['externalAdReply']
  }

  return ctx
}

/**
 * Procesa el texto aplicando markdown y prepara las menciones.
 * Devuelve el texto final + el array de JIDs mencionados.
 */
export function processText(
  text: string,
  opts: DecorationOptions | undefined
): { text: string; mentionedJid?: string[] } {
  if (!opts) return { text }

  let finalText = text
  if (opts.parseMarkdown) {
    finalText = convertMarkdown(finalText)
  }

  let mentionedJid: string[] | undefined
  if (opts.mentions && opts.mentions.length > 0) {
    mentionedJid = opts.mentions.map(m => {
      const cleaned = m.phone.replace(/[^\d]/g, '')
      return `${cleaned}@s.whatsapp.net`
    })
  }

  return { text: finalText, mentionedJid }
}

/**
 * Builder principal: dado un texto + opciones + multimedia opcional,
 * construye el payload `AnyMessageContent` listo para sock.sendMessage().
 *
 * @param payload.text         Texto del mensaje
 * @param payload.media        Multimedia opcional (Buffer o ruta)
 * @param payload.mediaType    Tipo de multimedia: image | video | audio | document | sticker
 * @param payload.fileName     Nombre de archivo para documentos
 * @param payload.decorations  Opciones de decoración
 * @param payload.quoted       Mensaje a citar (opcional)
 */
export interface BuildMessagePayload {
  text?: string
  media?: Buffer | { url: string }
  mediaType?: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  fileName?: string
  mimeType?: string
  decorations?: DecorationOptions
  quoted?: AnyMessageContent | { key: { id: string; remoteJid: string } }
}

export function buildMessage(input: BuildMessagePayload): AnyMessageContent {
  const decorations = input.decorations
  const contextInfo = buildContextInfo(decorations)
  const processed = processText(input.text ?? '', decorations)

  // Caso 1: sólo texto, sin multimedia
  if (!input.media) {
    const msg: AnyMessageContent = {
      text: processed.text
    } as AnyMessageContent
    if (contextInfo) {
      ;(msg as { contextInfo?: WAContextInfo }).contextInfo = contextInfo
    } else if (processed.mentionedJid) {
      ;(msg as { contextInfo?: WAContextInfo }).contextInfo = { mentionedJid: processed.mentionedJid }
    }
    return msg
  }

  // Caso 2: multimedia + caption
  // Siempre incluir mimetype y fileName para mejor compatibilidad con baileys
  // (el otro bot que funciona bien siempre los pasa).
  const caption = processed.text || undefined
  const mediaOpts: Record<string, unknown> = {
    mimetype: input.mimeType ?? 'application/octet-stream'
  }
  if (caption) mediaOpts.caption = caption
  if (input.fileName) mediaOpts.fileName = input.fileName
  if (contextInfo) mediaOpts.contextInfo = contextInfo
  else if (processed.mentionedJid) mediaOpts.contextInfo = { mentionedJid: processed.mentionedJid }

  switch (input.mediaType) {
    case 'image':
      return { image: input.media, ...mediaOpts } as AnyMessageContent
    case 'video':
      return { video: input.media, ...mediaOpts } as AnyMessageContent
    case 'audio':
      // Audio no soporta caption ni contextInfo de la misma forma
      return { audio: input.media, mimetype: input.mimeType ?? 'audio/mpeg', ptt: false } as AnyMessageContent
    case 'document':
      // Document requiere mimetype obligatorio
      return {
        document: input.media,
        mimetype: input.mimeType ?? 'application/octet-stream',
        ...mediaOpts
      } as AnyMessageContent
    case 'sticker':
      return { sticker: input.media } as AnyMessageContent
    default:
      return { text: processed.text } as AnyMessageContent
  }
}

/* ---------- Helpers rápidos para uso del panel (cosas pre-empaquetadas) ---------- */

/**
 * Crea opciones de decoración pre-configuradas para un "reenvío estándar".
 * Útil para el botón "Publicar como reenviado" del panel.
 */
export function forwardedDecoration(score: 1 | 25 | 100 = 1): DecorationOptions {
  return {
    forwarded: true,
    forwardingScore: score
  }
}

/**
 * Crea opciones para mencionar a una lista de usuarios.
 */
export function mentionsDecoration(mentions: MentionInput[]): DecorationOptions {
  return { mentions }
}

/**
 * Combina múltiples decoraciones en una sola.
 * Última gana en conflictos.
 */
export function combineDecorations(...decorators: (DecorationOptions | undefined)[]): DecorationOptions {
  const out: DecorationOptions = {}
  for (const d of decorators) {
    if (!d) continue
    if (d.forwarded) out.forwarded = true
    if (d.forwardingScore) out.forwardingScore = d.forwardingScore
    if (d.mentions) out.mentions = [...(out.mentions ?? []), ...d.mentions]
    if (d.linkPreview) out.linkPreview = d.linkPreview
    if (d.parseMarkdown) out.parseMarkdown = true
  }
  return out
}
