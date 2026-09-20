import { readFileSync } from 'node:fs'

/** Retardo asíncrono simple. */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Convierte un número de teléfono suelto (ej: 5491112345678)
 * en un JID válido para WhatsApp (ej: 5491112345678@s.whatsapp.net).
 */
export function toJid(phone: string): string {
  const cleaned = phone.replace(/[^\d]/g, '')
  if (cleaned.includes('@')) return cleaned
  if (cleaned.length < 4) return cleaned
  return `${cleaned}@s.whatsapp.net`
}

/** Devuelve solo la parte numérica de un JID (sin @s.whatsapp.net o @g.us). */
export function jidToPhone(jid: string): string {
  return jid.split('@')[0]
}

/** ¿Es un mensaje proveniente de un chat privado (DM)? */
export function isDM(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net')
}

/** ¿Es un mensaje proveniente de un grupo? */
export function isGroup(jid: string): boolean {
  return jid.endsWith('@g.us')
}

/** ¿Es un canal (WhatsApp Channels)? */
export function isChannel(jid: string): boolean {
  return jid.endsWith('@newsletter')
}

/** ¿Es un grupo O un canal? (cualquier destino donde el bot puede publicar) */
export function isPublishableDestination(jid: string): boolean {
  return isGroup(jid) || isChannel(jid)
}

/** Lee package.json del proyecto (para mostrar versión, etc.). */
export function readPackageInfo(): { name: string; version: string } {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
    const pkg = JSON.parse(raw)
    return {
      name: pkg.name || 'publisher-manager',
      version: pkg.version || '0.0.0'
    }
  } catch {
    return { name: 'publisher-manager', version: '0.0.0' }
  }
}

/**
 * Valida que un número de teléfono se vea razonable.
 * No verifica que exista en WhatsApp; sólo que tenga el formato esperado.
 */
export function isValidPhone(phone: string): boolean {
  const cleaned = phone.replace(/[^\d]/g, '')
  // Entre 7 y 15 dígitos (recomendación ITU-T E.164)
  return cleaned.length >= 7 && cleaned.length <= 15
}

/**
 * Detecta si un string es una URL http(s) válida.
 */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
