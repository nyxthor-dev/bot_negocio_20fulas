/**
 * Gestión de archivos multimedia del panel.
 *
 * Los archivos viven en data/media/<hex>.<ext> y los metadatos en la tabla
 * media (SQLite). El flujo del panel sube base64 por JSON, acá se valida,
 * se escribe a disco y queda registrado para que plantillas, programaciones
 * y publicaciones directas lo referencien por id.
 *
 * Con audio no se puede combinar caption en el mismo mensaje (limitación del
 * protocolo): el servicio de publicación manda el audio y el texto por separado.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  insertMedia,
  getMediaById,
  getMediaByIdAndAdmin,
  deleteMediaRow,
  countMediaReferences,
  type MediaRow
} from './db.ts'
import { logger } from './logger.ts'

const log = logger('media')

/** Límite por archivo: 50 MB (el bodyLimit del servidor está en 75 MB
 *  para que el base64 del JSON entre completo: 50 MB ≈ 69 MB en base64). */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024

const EXT_BY_TYPE: Record<MediaRow['media_type'], string> = {
  image: 'img',
  video: 'vid',
  audio: 'aud',
  document: 'doc',
  sticker: 'stk'
}

let mediaDir: string = resolve(process.cwd(), 'data', 'media')

/** Fija la carpeta donde se guardan los archivos (la llama index.ts al arrancar). */
export function configureMediaDir(dir: string): void {
  mediaDir = resolve(dir)
}

export function getMediaDir(): string {
  return mediaDir
}

/** Clasifica un mime type en el tipo de mensaje de WhatsApp que le corresponde.
 *  Los .webp van como sticker (formato especial de WhatsApp, heredado de v2). */
export function mediaTypeForMime(mime: string): MediaRow['media_type'] | null {
  const m = mime.toLowerCase()
  if (m === 'image/webp') return 'sticker'
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (
    m === 'application/pdf' ||
    m === 'application/octet-stream' ||
    m.startsWith('text/') ||
    m.startsWith('application/msword') ||
    m.startsWith('application/vnd.openxmlformats-officedocument') ||
    m.startsWith('application/vnd.oasis.opendocument') ||
    m === 'application/zip' ||
    m === 'application/x-zip-compressed'
  ) return 'document'
  return null
}

export interface SaveMediaInput {
  adminId: number
  base64: string
  mimeType: string
  fileName?: string
}

export type SaveMediaResult =
  | { ok: true; media: MediaRow }
  | { ok: false; error: string }

/**
 * Valida y guarda un archivo recibido como base64. Devuelve la fila completa
 * o un error descriptivo (nunca lanza: lo usan rutas HTTP).
 */
export function saveMediaFromBase64(input: SaveMediaInput): SaveMediaResult {
  const mime = String(input.mimeType ?? '').trim().toLowerCase()
  if (!mime) return { ok: false, error: 'Falta el tipo de archivo (mime).' }

  const mediaType = mediaTypeForMime(mime)
  if (!mediaType) {
    return { ok: false, error: `Tipo no soportado (${mime}). Usá imagen, video, audio o documento.` }
  }

  // Validación real del base64: Buffer.from('base64') NUNCA lanza (los
  // caracteres inválidos se descartan en silencio y un archivo corrupto
  // entraría como válido). Se normaliza y se verifica charset + padding.
  const b64 = String(input.base64 ?? '')
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '')
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, error: 'El base64 del archivo es inválido.' }
  }
  const buffer = Buffer.from(b64, 'base64')

  if (buffer.length === 0) return { ok: false, error: 'El archivo está vacío.' }
  if (buffer.length > MAX_MEDIA_BYTES) {
    return { ok: false, error: `El archivo supera el máximo de ${Math.floor(MAX_MEDIA_BYTES / (1024 * 1024))} MB.` }
  }

  const cleanName = String(input.fileName ?? 'archivo')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 120)

  mkdirSync(mediaDir, { recursive: true })
  const storagePath = resolve(mediaDir, `${randomBytes(16).toString('hex')}.${EXT_BY_TYPE[mediaType]}`)
  writeFileSync(storagePath, buffer)

  const id = insertMedia({
    admin_id: input.adminId,
    file_name: cleanName,
    mime_type: mime,
    media_type: mediaType,
    size: buffer.length,
    storage_path: storagePath,
    created_at: Date.now()
  })

  log.info({ id, mediaType, size: buffer.length, mime }, 'Multimedia guardada.')
  return { ok: true, media: getMediaById(id)! }
}

/** Lee el archivo al buffer. Lanza si el registro existe pero el archivo no. */
export function readMediaBuffer(row: MediaRow): Buffer {
  const storagePath = resolve(row.storage_path)
  if (!existsSync(storagePath)) {
    throw new Error(`El archivo de media ${row.id} no está en disco (${storagePath}).`)
  }
  return readFileSync(row.storage_path)
}

/**
 * Borra archivo + fila si NADIE lo referencia (plantillas / mensajes
 * programados). Se llama al eliminar plantillas o reemplazar mensajes.
 */
export function deleteMediaIfOrphan(mediaId: number | null | undefined): void {
  if (!mediaId) return
  const row = getMediaById(mediaId)
  if (!row) return
  if (countMediaReferences(mediaId) > 0) return
  try { unlinkSync(row.storage_path) } catch { /* ya no estaba */ }
  deleteMediaRow(mediaId)
  log.info({ id: mediaId }, 'Multimedia huérfana eliminada.')
}

/** Datos para el panel (serialización liviana, sin el archivo). */
export function mediaSummary(row: MediaRow): {
  id: number
  media_type: MediaRow['media_type']
  mime_type: string
  file_name: string
  size: number
  url: string
} {
  return {
    id: row.id,
    media_type: row.media_type,
    mime_type: row.mime_type,
    file_name: row.file_name,
    size: row.size,
    url: `/api/media/${row.id}`
  }
}

/** Resuelve un media id verificando dueño; devuelve error si no aplica. */
export function resolveOwnedMedia(mediaId: number, adminId: number): { ok: true; media: MediaRow } | { ok: false; error: string } {
  const media = getMediaByIdAndAdmin(mediaId, adminId)
  if (!media) return { ok: false, error: 'El archivo multimedia no existe o no es tuyo.' }
  return { ok: true, media }
}
