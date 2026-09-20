/**
 * Validaciones compartidas por las rutas que aceptan mensajes del panel
 * (publicación inmediata y mensajes de programaciones).
 */

import type { DecorationOptions } from './textDecorations.ts'

/** Longitud máxima del texto por mensaje (límite práctico de WhatsApp ~65k). */
export const MAX_TEXT_LEN = 65_000

/** JIDs válidos para destinos del panel: grupos (@g.us) y canales (@newsletter). */
export const JID_RE = /^[A-Za-z0-9_-]{2,120}@(g\.us|newsletter)$/

/**
 * Devuelve un mensaje de error si algún jid tiene formato inválido,
 * o null si todos son válidos.
 */
export function invalidJid(jids: string[], label: string): string | null {
  for (const jid of jids) {
    if (!JID_RE.test(jid)) {
      return `${label}: destino inválido (${jid.slice(0, 60)}).`
    }
  }
  return null
}

/**
 * Deja sólo las decoraciones que el panel usa (whitelist) con valores
 * saneados. Evita que un cliente mande claves arbitrarias que viajan
 * hasta el payload de Baileys.
 */
export function sanitizeDecorations(raw: unknown): DecorationOptions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw as Record<string, unknown>
  const out: DecorationOptions = {}
  if (typeof src.forwarded === 'boolean') out.forwarded = src.forwarded
  if (typeof src.parseMarkdown === 'boolean') out.parseMarkdown = src.parseMarkdown
  if (typeof src.forwardingScore === 'number' && Number.isFinite(src.forwardingScore)) {
    out.forwardingScore = Math.max(0, Math.min(255, Math.floor(src.forwardingScore)))
  }
  return Object.keys(out).length > 0 ? out : null
}
