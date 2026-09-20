/**
 * Test de confirmación de entrega: veredictos del servidor (acks), reintento
 * de subida de multimedia y reintegro honesto por destino.
 */

import { EventEmitter } from 'node:events'
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type { WASocket } from '@fer2809fl/baileys'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

let passed = 0
let failed = 0

function ok (name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}`)
  } else {
    failed++
    console.error(`  [FAIL] ${name} ${extra}`)
  }
}

async function main () {
  // El fork de baileys importa axios dinámicamente para subir multimedia:
  // si falta, TODAS las subidas fallan con "Media upload failed on all hosts".
  console.log('\n=== 1. Dependencia de subida de multimedia ===')
  let axiosOk = false
  try {
    const mod = await import('axios')
    axiosOk = typeof mod.default?.post === 'function' || typeof (mod as unknown as { post?: unknown }).post === 'function'
  } catch { /* no instalado */ }
  ok('axios instalado y cargable (upload de multimedia)', axiosOk)

  const delivery = await import('../lib/delivery.ts')

  console.log('\n=== 2. Mapeo de códigos de error de ack ===')
  ok('403 habla de restricción', delivery.describeAckError('403').includes('restringe'))
  ok('405 habla de restricción', delivery.describeAckError(' 405 ').includes('restringe'))
  ok('475 habla de dispositivos', delivery.describeAckError('475').includes('dispositivos'))
  ok('código desconocido se muestra tal cual', delivery.describeAckError('999').includes('999'))

  console.log('\n=== 3. Veredictos desde acks crudos y updates ===')
  // Socket falso: ws y ev son EventEmitters, suficiente para los listeners
  const fakeSock = { ws: new EventEmitter(), ev: new EventEmitter() } as unknown as WASocket
  delivery.attachDeliveryWatchers(fakeSock)

  const emitAck = (id: string, error?: string) => {
    fakeSock.ws.emit('CB:ack,class:message', { attrs: { id, ...(error ? { error } : {}) } })
  }

  emitAck('msg-ok')
  let verdict = await delivery.awaitDelivery(['msg-ok'], false, () => true, 500)
  ok('ack limpio → enviado', verdict.ok === true)

  emitAck('msg-rejected', '403')
  verdict = await delivery.awaitDelivery(['msg-rejected'], false, () => true, 500)
  ok('ack con error 403 → fallo con detalle', verdict.ok === false && (verdict.error ?? '').includes('restringe'))

  fakeSock.ev.emit('messages.update', [
    { key: { id: 'msg-stub', fromMe: true }, update: { status: 0, messageStubParameters: ['403', 'extra'] } }
  ])
  verdict = await delivery.awaitDelivery(['msg-stub'], false, () => true, 500)
  ok('messages.update con status ERROR → fallo', verdict.ok === false && (verdict.error ?? '').includes('403'))

  fakeSock.ev.emit('messages.update', [
    { key: { id: 'msg-otro', fromMe: true }, update: { status: 3 } }
  ])
  verdict = await delivery.awaitDelivery(['msg-nunca-visto'], false, () => true, 300)
  ok('sin señal en el plazo → fallo honesto (grupo)', verdict.ok === false && (verdict.error ?? '').includes('nunca confirmó'))

  verdict = await delivery.awaitDelivery(['msg-nunca-visto-2'], true, () => true, 300)
  ok('sin señal en el plazo → canales no se marcan fallidos', verdict.ok === true)

  verdict = await delivery.awaitDelivery(['msg-caida'], false, () => false, 5000)
  ok('conexión caída durante la espera → fallo', verdict.ok === false && (verdict.error ?? '').includes('conexión se cerró'))

  emitAck('multi-a')
  emitAck('multi-b', '405')
  verdict = await delivery.awaitDelivery(['multi-a', 'multi-b'], false, () => true, 500)
  ok('uno de varios mensajes rechazado → el destino falla', verdict.ok === false && (verdict.error ?? '').includes('restringe'))

  emitAck('multi-c')
  emitAck('multi-d')
  verdict = await delivery.awaitDelivery(['multi-c', 'multi-d'], false, () => true, 500)
  ok('varios mensajes confirmados → destino OK', verdict.ok === true)

  console.log('\n=== 4. Reintento de subida de multimedia ===')
  const started = Date.now()
  let calls = 0
  let refreshForced = 0
  const flakySock = {
    sendMessage: async (_jid: string, _content: unknown, _opts: unknown) => {
      calls++
      if (calls === 1) {
        throw new Error('Media upload failed on all hosts')
      }
      return { key: { id: 'msg-retry-' + calls } }
    },
    refreshMediaConn: async (force?: boolean) => {
      refreshForced++
      return { hosts: [], auth: '', ttl: 300, fetchDate: new Date() }
    },
    ws: new EventEmitter(),
    ev: new EventEmitter()
  } as unknown as WASocket

  const retried = await delivery.sendWithUploadRetry(flakySock, '1@g.us', { text: 'hola' } as never)
  ok('reintento exitoso tras fallo de subida', retried?.key?.id === 'msg-retry-2' && calls === 2)
  ok('se renovó la conexión de media (force)', refreshForced === 1)

  let hardCalls = 0
  const alwaysFailSock = {
    sendMessage: async () => {
      hardCalls++
      throw new Error('Media upload failed on all hosts')
    },
    refreshMediaConn: async () => ({}),
    ws: new EventEmitter(),
    ev: new EventEmitter()
  } as unknown as WASocket
  let threw: unknown = null
  try {
    await delivery.sendWithUploadRetry(alwaysFailSock, '1@g.us', { text: 'x' } as never)
  } catch (err) { threw = err }
  ok('subida que siempre falla → lanza tras los reintentos', threw !== null && hardCalls === 3)

  let normalCalls = 0
  const normalFailSock = {
    sendMessage: async () => {
      normalCalls++
      throw new Error('All encryptions failed')
    },
    ws: new EventEmitter(),
    ev: new EventEmitter()
  } as unknown as WASocket
  let threw2: unknown = null
  try {
    await delivery.sendWithUploadRetry(normalFailSock, '1@g.us', { text: 'x' } as never)
  } catch (err) { threw2 = err }
  ok('error que no es de subida → no se reintenta', threw2 !== null && normalCalls === 1)

  const elapsed = Date.now() - started
  ok('los reintentos respetan la espera creciente', elapsed >= 4000, `tardó ${elapsed}ms`)

  console.log(`\n=== Resultados: ${passed} PASS, ${failed} FAIL ===`)
  if (failed > 0) {
    console.error('❌ Hay tests fallando.')
    process.exit(1)
  }
  console.log('✅ Todos los tests pasaron.')
}

main().catch(err => {
  console.error('Error fatal del test:', err)
  process.exit(1)
})
