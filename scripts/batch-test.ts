/**
 * Test del flujo completo: batch + historial agrupado.
 * Sin conectar a WhatsApp — sólo valida la lógica de DB.
 */
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { openDatabase, closeDatabase, createPublishBatch, insertPublishLog, updatePublishLogStatus, finalizePublishBatch, getRecentPublishBatches, getPublishLogByBatch } from '../lib/db.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = resolve(__dirname, '..', 'data', 'test-batch.db')
for (const p of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  if (existsSync(p)) rmSync(p)
}

console.log('=== Test: Flujo de publicación con batch ===\n')

openDatabase(TEST_DB)

console.log('--- Crear batch 1: publicación a 5 destinos ---')
const batch1 = createPublishBatch({
  contentType: 'text',
  text: 'Hola *mundo*!',
  mediaPath: null,
  decorations: JSON.stringify({ forwarded: true, parseMarkdown: true }),
  totalTargets: 5,
  sentAt: Date.now()
})
console.log(`Batch creado con ID: ${batch1}`)

// Simular 5 destinos
const targets1 = ['a@g.us', 'b@g.us', 'c@g.us', 'd@g.us', 'e@newsletter']
const logIds1 = targets1.map(jid => insertPublishLog({
  batch_id: batch1,
  target_jid: jid,
  content_type: 'text',
  text: 'Hola *mundo*!',
  media_path: null,
  status: 'pending',
  sent_at: Date.now(),
  error: null
}))
console.log(`Logs individuales creados: ${logIds1.length}`)

// Simular resultados: 4 OK, 1 fallido
updatePublishLogStatus(logIds1[0], 'sent')
updatePublishLogStatus(logIds1[1], 'sent')
updatePublishLogStatus(logIds1[2], 'sent')
updatePublishLogStatus(logIds1[3], 'sent')
updatePublishLogStatus(logIds1[4], 'failed', 'Forbidden: not admin in this channel')
finalizePublishBatch(batch1, 4, 1)

console.log('\n--- Crear batch 2: publicación a 13 destinos (todos OK) ---')
const batch2 = createPublishBatch({
  contentType: 'text',
  text: 'Mensaje broadcast',
  mediaPath: null,
  decorations: null,
  totalTargets: 13,
  sentAt: Date.now()
})
const logIds2 = Array.from({ length: 13 }, (_, i) => insertPublishLog({
  batch_id: batch2,
  target_jid: `dest${i}@g.us`,
  content_type: 'text',
  text: 'Mensaje broadcast',
  media_path: null,
  status: 'pending',
  sent_at: Date.now(),
  error: null
}))
logIds2.forEach(id => updatePublishLogStatus(id, 'sent'))
finalizePublishBatch(batch2, 13, 0)

console.log('\n--- Consultar historial (debe devolver 2 batches, no 18 entradas) ---')
const history = getRecentPublishBatches(50)
console.log(`Cantidad de batches en historial: ${history.length}`)
history.forEach(b => {
  console.log(`  [${b.id}] "${b.text}" | ${b.sent_count}/${b.total_targets} enviados | estado=${b.status} | ${(b.decorations ? JSON.parse(b.decorations) : null) ? 'con decoraciones' : 'sin decoraciones'}`)
})

console.log('\n--- Consultar detalles del batch 1 ---')
const details1 = getPublishLogByBatch(batch1)
console.log(`Batch ${batch1} tiene ${details1.length} destinos:`)
details1.forEach(d => {
  console.log(`  - ${d.target_jid}: ${d.status}${d.error ? ' (error: ' + d.error + ')' : ''}`)
})

console.log('\n--- Consultar detalles del batch 2 ---')
const details2 = getPublishLogByBatch(batch2)
console.log(`Batch ${batch2} tiene ${details2.length} destinos (todos sent)`)

closeDatabase()

let pass = 0, fail = 0
if (history.length === 2) { pass++ } else { fail++; console.error(`FAIL: esperaba 2 batches, hay ${history.length}`) }
if (history[0].sent_count === 13) { pass++ } else { fail++; console.error(`FAIL: esperaba 13 sent en batch2, hay ${history[0].sent_count}`) }
if (history[1].sent_count === 4 && history[1].failed_count === 1) { pass++ } else { fail++; console.error(`FAIL: esperaba 4 sent + 1 failed en batch1`) }
if (history[1].status === 'partial') { pass++ } else { fail++; console.error(`FAIL: esperaba status=partial en batch1`) }
if (details1.length === 5) { pass++ } else { fail++; console.error(`FAIL: esperaba 5 detalles en batch1`) }

console.log(`\n=== Resultados: ${pass} PASS, ${fail} FAIL ===`)
if (fail > 0) process.exit(1)
console.log('✅ Todos los tests pasaron.')
