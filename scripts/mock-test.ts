/**
 * Mock test v2: simula el escenario real del usuario con LID.
 *
 * Caso real: el bot aparece en grupos con un LID distinto al número de teléfono.
 * El mock simula sockSingleton.user con id, phoneNumber y lid.
 */

import type { GroupMetadata, GroupParticipant } from '@fer2809fl/baileys'

// === Simulación del bot real ===
const BOT_USER = {
  id: '5356795360:13@s.whatsapp.net',           // con device ID
  phoneNumber: '5356795360@s.whatsapp.net',     // PN sin device
  lid: '186608359854264@lid'                     // LID (totalmente distinto número)
}

// === Mock data: 4 grupos admin + 1 no admin ===
const mockGroups: GroupMetadata[] = [
  // Grupo 1: bot aparece como LID (caso típico de grupos nuevos)
  {
    id: '1203630001@g.us',
    subject: 'Grupo Admin 1 (LID, superadmin)',
    participants: [
      { id: BOT_USER.lid, admin: 'superadmin' },
      { id: '276772692222150@lid', admin: 'admin' }
    ]
  } as GroupMetadata,

  // Grupo 2: bot aparece como PN
  {
    id: '1203630002@g.us',
    subject: 'Grupo Admin 2 (PN, admin)',
    participants: [
      { id: BOT_USER.phoneNumber, admin: 'admin' }
    ]
  } as GroupMetadata,

  // Grupo 3: bot aparece como PN con device ID
  {
    id: '1203630003@g.us',
    subject: 'Grupo Admin 3 (PN:device, admin)',
    participants: [
      { id: BOT_USER.id, admin: 'admin' }
    ]
  } as GroupMetadata,

  // Grupo 4: bot aparece con id=LID pero trae phoneNumber explícito
  {
    id: '1203630004@g.us',
    subject: 'Grupo Admin 4 (LID + phoneNumber, admin)',
    participants: [
      {
        id: BOT_USER.lid,
        lid: BOT_USER.lid,
        phoneNumber: BOT_USER.phoneNumber,
        admin: 'admin'
      } as GroupParticipant
    ]
  } as GroupMetadata,

  // Grupo 5: NO admin
  {
    id: '1203630005@g.us',
    subject: 'Grupo NO Admin',
    participants: [
      { id: BOT_USER.phoneNumber, admin: null },
      { id: '8888888888@s.whatsapp.net', admin: 'admin' }
    ]
  } as GroupMetadata
]

// === Implementación idéntica a client.ts (sin acceso al socket real) ===

function normalizeJid(jid: string | undefined | null): string | null {
  if (!jid || typeof jid !== 'string') return null
  const atIdx = jid.indexOf('@')
  if (atIdx < 0) return jid
  const localPart = jid.slice(0, atIdx)
  const domain = jid.slice(atIdx)
  const colonIdx = localPart.indexOf(':')
  const cleanLocal = colonIdx >= 0 ? localPart.slice(0, colonIdx) : localPart
  return `${cleanLocal}${domain}`
}

function safeStr(v: unknown, fallback: string = ''): string {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  return fallback
}

// Mock de getMyBotJids (versión simplificada sin socket)
function getMyBotJids(user: { id?: string; phoneNumber?: string; lid?: string }): string[] {
  const variants = new Set<string>()
  if (user.id) {
    variants.add(user.id)
    const norm = normalizeJid(user.id)
    if (norm) variants.add(norm)
  }
  if (user.phoneNumber) {
    variants.add(user.phoneNumber)
    const norm = normalizeJid(user.phoneNumber)
    if (norm) variants.add(norm)
  }
  if (user.lid) {
    variants.add(user.lid)
    const norm = normalizeJid(user.lid)
    if (norm) variants.add(norm)
  }
  return Array.from(variants)
}

// Mock de isBotAdminOfGroup (sólo fallback manual, sin sock.isGroupAdmin)
function isBotAdminOfGroup(g: GroupMetadata, user: typeof BOT_USER): boolean {
  const myJids = getMyBotJids(user)
  if (myJids.length === 0) return false

  const myJidVariants = new Set(myJids)

  const me = g.participants?.find(p => {
    const candidates = [
      normalizeJid(p.id),
      p.lid ? normalizeJid(p.lid) : null,
      p.phoneNumber ? normalizeJid(p.phoneNumber) : null
    ].filter((v): v is string => v !== null)
    return candidates.some(c => myJidVariants.has(c))
  })

  if (!me) return false

  return me.admin === 'admin'
    || me.admin === 'superadmin'
}

// === Ejecutar tests ===
console.log('=== Test matching con LID + PN + device ID ===')
console.log(`Bot user:`, BOT_USER)
console.log(`Variantes generadas:`, getMyBotJids(BOT_USER))
console.log('')

let pass = 0
let fail = 0

for (const g of mockGroups) {
  const isAdmin = isBotAdminOfGroup(g, BOT_USER)
  const expected = !g.subject?.includes('NO Admin')
  const status = isAdmin === expected ? 'PASS' : 'FAIL'
  if (status === 'PASS') pass++
  else fail++

  console.log(`[${status}] ${g.subject}`)
  console.log(`   JID: ${g.id}`)
  console.log(`   isAdmin: ${isAdmin} (esperado: ${expected})`)
  console.log('')
}

console.log('=== Test safeStr ===')
const safeStrTests: Array<[unknown, string, string]> = [
  ['hola', 'fb', 'hola'],
  [123, 'fb', '123'],
  [null, 'fb', 'fb'],
  [undefined, 'fb', 'fb'],
  [{ obj: true }, 'fb', 'fb'],
  [Buffer.from('test'), 'fb', 'fb']
]
for (const [input, fallback, expected] of safeStrTests) {
  const result = safeStr(input, fallback)
  const status = result === expected ? 'PASS' : 'FAIL'
  if (status === 'PASS') pass++
  else fail++
  console.log(`[${status}] safeStr(${JSON.stringify(input)}, "${fallback}") = "${result}" (esperado: "${expected}")`)
}

console.log('')
console.log('=== Test thread_metadata nombre (casos posibles) ===')

// Caso A: thread_metadata.name es string directo
const mockA = {
  thread_metadata: { name: 'Canal A', creation_time: 123 }
}
const nameA = safeStr(mockA.thread_metadata.name as string)
const statusA = nameA === 'Canal A' ? 'PASS' : 'FAIL'
if (statusA === 'PASS') pass++
else fail++
console.log(`[${statusA}] thread_metadata.name (string) → "${nameA}"`)

// Caso B: thread_metadata.name es objeto con .text
const mockB = {
  thread_metadata: { name: { text: 'Canal B' }, creation_time: 123 }
}
const nameB = safeStr((mockB.thread_metadata.name as { text?: string }).text)
const statusB = nameB === 'Canal B' ? 'PASS' : 'FAIL'
if (statusB === 'PASS') pass++
else fail++
console.log(`[${statusB}] thread_metadata.name.text (objeto) → "${nameB}"`)

// Caso C: thread_metadata sin name
const mockC = {
  thread_metadata: { creation_time: 123 }
}
const nameC = safeStr((mockC.thread_metadata as { name?: string }).name)
  || safeStr((mockC.thread_metadata as { name?: { text?: string } }).name?.text)
  || '(canal sin nombre)'
const statusC = nameC === '(canal sin nombre)' ? 'PASS' : 'FAIL'
if (statusC === 'PASS') pass++
else fail++
console.log(`[${statusC}] thread_metadata sin name → "${nameC}"`)

console.log('')
console.log(`=== Resultados: ${pass} PASS, ${fail} FAIL ===`)
if (fail > 0) {
  console.error('❌ Hay tests fallando.')
  process.exit(1)
} else {
  console.log('✅ Todos los tests pasaron.')
}
