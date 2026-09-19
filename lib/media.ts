/**
 * Gestión de archivos multimedia para publicación.
 *
 * Guarda los archivos subidos vía panel web en `data/media/` con nombres únicos
 * para evitar colisiones. Valida tipo y tamaño.
 *
 * Tipos soportados (según WhatsApp):
 *   - image/jpeg, image/png, image/webp
 *   - video/mp4
 *   - audio/mpeg, audio/ogg
 *   - application/pdf, application/zip
 *   - application/vnd.openxmlformats-officedocument.wordprocessingml.document (docx)
 *   - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (xlsx)
 *   - text/plain
 *
 * Stickers: image/webp con tipo "sticker" explícito (WhatsApp requiere formato especial)
 */

import { createWriteStream, mkdirSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { resolve, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MultipartFile } from '@fastify/multipart'
import { logger } from './logger.ts'

const log = logger('media')

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MEDIA_DIR = resolve(__dirname, '..', 'data', 'media')

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export interface MediaFile {
  /** Path absoluto donde se guardó el archivo */
  path: string
  /** Path relativo al directorio de media (para guardar en DB) */
  relativePath: string
  /** Nombre original del archivo subido */
  originalName: string
  /** Nombre único generado (uuid + extensión) */
  storedName: string
  /** MIME type detectado */
  mimeType: string
  /** Tamaño en bytes */
  size: number
  /** Tipo categorizado para WhatsApp */
  mediaType: MediaType
  /** Extensión del archivo (ej: .jpg) */
  extension: string
}

/** MIME types permitidos y su tipo WhatsApp correspondiente */
const MIME_TO_TYPE: Record<string, MediaType> = {
  // Imágenes
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  // Videos
  'video/mp4': 'video',
  // Audio
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/ogg': 'audio',
  'audio/aac': 'audio',
  // Documentos
  'application/pdf': 'document',
  'application/zip': 'document',
  'application/x-zip-compressed': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'application/msword': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'text/plain': 'document',
  'text/csv': 'document'
}

/** Extensión por defecto según MIME type si no se puede inferir del nombre */
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
  'text/plain': '.txt',
  'text/csv': '.csv'
}

const MAX_FILE_SIZE = 50 * 1024 * 1024  // 50 MB

/**
 * Determina el MediaType a partir de un MIME type.
 * Si no se reconoce, devuelve 'document' como fallback (WhatsApp lo acepta así).
 */
export function getMediaType(mimeType: string): MediaType {
  return MIME_TO_TYPE[mimeType.toLowerCase()] ?? 'document'
}

/**
 * Devuelve la extensión de archivo según el MIME type.
 */
export function getExtensionForMime(mimeType: string, fallbackFromName?: string): string {
  const ext = MIME_TO_EXTENSION[mimeType.toLowerCase()]
  if (ext) return ext
  if (fallbackFromName) {
    const extFromName = extname(fallbackFromName).toLowerCase()
    if (extFromName) return extFromName
  }
  return '.bin'
}

/**
 * Valida que el archivo no exceda el tamaño máximo y que el MIME sea conocido.
 * Lanza error si no pasa la validación.
 */
export function validateMedia(mimeType: string, size: number): void {
  if (size > MAX_FILE_SIZE) {
    throw new Error(`Archivo demasiado grande: ${(size / 1024 / 1024).toFixed(2)}MB. Máximo: 50MB.`)
  }
  if (!MIME_TO_TYPE[mimeType.toLowerCase()]) {
    log.warn({ mimeType }, 'MIME type no reconocido — se enviará como documento genérico.')
  }
}

/**
 * Guarda un archivo recibido vía multipart en el disco.
 *
 * @param file         Archivo multipart de Fastify
 * @param mediaDir     Directorio base (default: data/media/)
 * @param forceType    Forzar tipo (ej: 'sticker' para .webp que es sticker, no imagen)
 * @returns            Metadata del archivo guardado
 */
export async function saveMediaFile(
  file: MultipartFile,
  mediaDir: string = DEFAULT_MEDIA_DIR,
  forceType?: MediaType
): Promise<MediaFile> {
  const originalName = file.filename || 'unknown'
  const mimeType = file.mimetype || 'application/octet-stream'
  const extension = getExtensionForMime(mimeType, originalName)
  const storedName = `${Date.now()}-${randomUUID()}${extension}`
  const fullPath = join(mediaDir, storedName)

  mkdirSync(mediaDir, { recursive: true })

  // Validar tamaño mientras se guarda (acumulamos bytes)
  let totalSize = 0
  const writeStream = createWriteStream(fullPath)

  try {
    await pipeline(file.file, async function* (source) {
      for await (const chunk of source) {
        totalSize += chunk.length
        if (totalSize > MAX_FILE_SIZE) {
          throw new Error(`Archivo demasiado grande (máximo ${MAX_FILE_SIZE / 1024 / 1024}MB)`)
        }
        yield chunk
      }
    }, writeStream)
  } catch (err) {
    // Si falla, borrar el archivo parcial
    try {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(fullPath)
    } catch {
      // sinop
    }
    throw err
  }

  // Verificar tamaño final
  const stats = statSync(fullPath)
  const size = stats.size

  validateMedia(mimeType, size)

  const mediaType = forceType ?? getMediaType(mimeType)

  const media: MediaFile = {
    path: fullPath,
    relativePath: `data/media/${storedName}`,
    originalName,
    storedName,
    mimeType,
    size,
    mediaType,
    extension
  }

  log.info({
    storedName,
    originalName,
    mimeType,
    size,
    mediaType
  }, `Media guardado (${(size / 1024).toFixed(1)}KB)`)

  return media
}

/**
 * Lee un archivo guardado y lo retorna como Buffer para enviar vía baileys.
 *
 * NOTA: Para subidas a WhatsApp, preferir usar `getMediaPath()` y pasarlo
 * directamente a baileys como `{ url: '/path/absoluto' }`. Eso evita cargar
 * el archivo entero en memoria y usa streaming directo del disco.
 */
export async function readMediaFile(relativePath: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  const fullPath = resolve(__dirname, '..', relativePath)
  return await readFile(fullPath)
}

/**
 * Devuelve el path absoluto del archivo guardado para pasarlo
 * directamente a baileys como `{ url: path }`.
 *
 * Baileys soporta pasar paths absolutos en lugar de Buffers para
 * imágenes/videos/etc. Esto evita cargar el archivo en memoria y
 * permite subidas más estables.
 */
export function getMediaPath(mediaFile: MediaFile): string {
  return mediaFile.path
}
