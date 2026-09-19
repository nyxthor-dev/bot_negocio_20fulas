// Filtro de ruido de consola.
//
// libsignal y baileys imprimen directamente a console.log/console.warn/console.error
// en varios puntos. Esto se escapa del logger pino y aparece en la consola.
// Filtramos los patrones conocidos de ruido.

const SILENCED_PATTERNS: RegExp[] = [
  // libsignal / sesión Signal
  /^Closing (?:open )?session/i,
  /^SessionEntry \{/,
  /^SessionEntry\b/,
  /^prekey bundle/i,
  /^DecryptionError/i,
  /^Dropping untrusted prekey bundle/i,
  /^InboundSession\b/,
  /^OutboundSession\b/,
  /^Identity\b/,
  /^PreKey\b/,
  /^SignedPreKey\b/,

  // baileys / ourin-baileys warnings
  /ourin-baileys\] WARNING/i,
  /fluent-ffmpeg/i,
  /^👉 Please run:/i,
  /Video previews may not work/i,

  // Otros ruidos comunes
  /^protobufjs/i,
  /^\[protobufjs\]/i
]

const originalConsoleLog = console.log
const originalConsoleDebug = console.debug
const originalConsoleWarn = console.warn
const originalConsoleError = console.error

function shouldSilence(args: unknown[]): boolean {
  if (args.length === 0) return false
  const first = args[0]
  if (typeof first !== 'string') {
    // Caso SessionEntry: console.log(SessionEntry { ... }) — el primer arg es un objeto
    if (first && typeof first === 'object' && typeof (first as { _chains?: unknown })._chains === 'object') {
      return true
    }
    return false
  }
  return SILENCED_PATTERNS.some(p => p.test(first.trim()))
}

/**
 * Parchea console.log / console.debug / console.warn / console.error
 * para suprimir mensajes conocidos de ruido interno de libsignal y baileys.
 *
 * Llamar una sola vez al arrancar el bot. Es idempotente.
 */
export function silenceConsoleNoise(): void {
  if ((console.log as { __silenced?: boolean }).__silenced) return

  const wrap = (original: (...args: unknown[]) => void) =>
    function (this: unknown, ...args: unknown[]): void {
      if (shouldSilence(args)) return
      original.apply(this, args)
    }

  const silencedLog = wrap(originalConsoleLog)
  ;(silencedLog as { __silenced?: boolean }).__silenced = true
  console.log = silencedLog as typeof console.log
  console.debug = wrap(originalConsoleDebug) as typeof console.debug
  console.warn = wrap(originalConsoleWarn) as typeof console.warn
  console.error = wrap(originalConsoleError) as typeof console.error
}
