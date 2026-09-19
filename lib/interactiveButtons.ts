/**
 * Módulo de botones interactivos nativos de WhatsApp (sistema nuevo native flow).
 *
 * Esta versión usa el sistema `interactiveButtons` de baileys (más moderno
 * que el `templateButtons` legacy). Soporta:
 *
 *   - URL button (cta_url):    abre un enlace al hacer click
 *   - COPY button (cta_copy):  copia un código al portapapeles
 *
 * NOTAS:
 *  - WhatsApp permite máximo 1 botón nativo (cta_*) por mensaje con esta API.
 *  - Si se necesitan más botones, combinar con quick_reply (pero no son CTA).
 *  - Los botones CTA requieren cuenta Business para verse correctamente en
 *    clientes recientes.
 *  - Los botones NO se pueden combinar con multimedia en la versión actual.
 */

import type { AnyMessageContent } from '@fer2809fl/baileys'
import { randomUUID } from 'node:crypto'
import { buildContextInfo, type DecorationOptions } from './textDecorations.ts'

/* ---------- Definiciones declarativas ---------- */

export type ButtonType = 'url' | 'copy'

export interface ButtonSpec {
  type: ButtonType
  /** Texto visible del botón. Máx 60 chars. */
  displayText: string
  /** URL para botones tipo 'url'. Debe ser http(s). */
  url?: string
  /** Código a copiar al portapapeles para botones tipo 'copy'. */
  copyCode?: string
}

/* ---------- Builder ---------- */

/**
 * Construye el payload `interactiveButtons` para un solo botón nativo.
 *
 * Formato esperado por baileys (Dugong.handleInteractiveButtons):
 *   interactiveButtons: [{ name: 'cta_url', buttonParamsJson: '...' }]
 *
 * El buttonParamsJson debe contener:
 *   - cta_url:  { display_text, url, merchant_url }
 *   - cta_copy: { display_text, copy_code, id }  ← id es REQUERIDO
 *
 * @param input.text         Texto del mensaje (cuerpo)
 * @param input.button       Botón único (URL o COPY)
 * @param input.footer       Texto pie opcional
 * @param input.decorations  Opciones de decoración (forwarded, menciones, etc.)
 */
export interface BuildNativeButtonPayload {
  text: string
  button: ButtonSpec
  footer?: string
  decorations?: DecorationOptions
}

export function buildNativeButtonMessage(
  input: BuildNativeButtonPayload
): AnyMessageContent {
  const button = input.button
  validateButton(button)

  // Construir el botón según tipo usando el formato cta_* de WhatsApp native flow
  let nativeButton: { name: string; buttonParamsJson: string }

  switch (button.type) {
    case 'url': {
      const params = {
        display_text: button.displayText,
        url: button.url!,
        merchant_url: button.url
      }
      nativeButton = {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify(params)
      }
      break
    }
    case 'copy': {
      // cta_copy REQUIERE un id único, sino WhatsApp no registra el toque
      const params = {
        display_text: button.displayText,
        copy_code: button.copyCode!,
        id: randomUUID()
      }
      nativeButton = {
        name: 'cta_copy',
        buttonParamsJson: JSON.stringify(params)
      }
      break
    }
    default:
      throw new Error(`Tipo de botón no soportado: ${(button as { type: string }).type}`)
  }

  // Context info para decoraciones (forwarded, mentions, etc.)
  const contextInfo = buildContextInfo(input.decorations)

  // Para URL buttons: agregar previewUrl para que WhatsApp renderice
  // la tarjeta de preview del link automáticamente.
  const extraFields: Record<string, unknown> = {}
  if (button.type === 'url' && button.url) {
    extraFields.previewUrl = button.url
  }

  const message: AnyMessageContent = {
    text: input.text,
    footer: input.footer,
    interactiveButtons: [nativeButton],
    ...extraFields,
    ...(contextInfo ? { contextInfo: contextInfo as never } : {})
  } as AnyMessageContent

  return message
}

/* ---------- Helpers de validación ---------- */

/**
 * Valida un ButtonSpec individual. Lanza error si falta algo requerido.
 */
export function validateButton(btn: ButtonSpec): void {
  if (!btn.displayText || btn.displayText.trim().length === 0) {
    throw new Error('El botón requiere displayText no vacío.')
  }
  if (btn.displayText.length > 60) {
    throw new Error(`displayText demasiado largo (máx 60 chars): "${btn.displayText}"`)
  }
  switch (btn.type) {
    case 'url':
      if (!btn.url) throw new Error('Botón URL requiere "url".')
      try { new URL(btn.url) } catch { throw new Error(`URL inválida: ${btn.url}`) }
      break
    case 'copy':
      if (!btn.copyCode) throw new Error('Botón COPY requiere "copyCode".')
      if (btn.copyCode.length > 1000) {
        throw new Error('copyCode demasiado largo (máx 1000 chars)')
      }
      break
    default:
      throw new Error(`Tipo de botón no soportado: ${(btn as { type: string }).type}`)
  }
}

/* ---------- Helpers concisos ---------- */

export function urlButton(displayText: string, url: string): ButtonSpec {
  return { type: 'url', displayText, url }
}

export function copyButton(displayText: string, copyCode: string): ButtonSpec {
  return { type: 'copy', displayText, copyCode }
}
