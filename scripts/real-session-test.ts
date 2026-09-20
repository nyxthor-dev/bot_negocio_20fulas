/**
 * Test: validar lógica de grupos/canales con sesión real del bot.
 *
 * NO se conecta a WhatsApp. Sólo carga el creds.json de una cuenta para
 * obtener el user.id y user.lid reales, y valida que la lógica de matching
 * funcione correctamente con datos de prueba.
 *
 * Busca la primera carpeta data/auth/<id>/creds.json disponible.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

console.log('=== Test con sesión real del bot ===\n')

// 1. Leer creds.json de la primera cuenta que exista
const authRoot = resolve('data/auth')
let credsPath: string | null = null
if (existsSync(authRoot)) {
  for (const entry of readdirSync(authRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = resolve(authRoot, entry.name, 'creds.json')
      if (existsSync(candidate)) {
        credsPath = candidate
        break
      }
    }
  }
}
// Compat: carpeta legacy de la v2 (creds.json directo en data/auth)
if (!credsPath) {
  const legacy = resolve('data/auth/creds.json')
  if (existsSync(legacy)) credsPath = legacy
}

if (!credsPath) {
  console.log('No hay sesiones guardadas (data/auth/<id>/creds.json). Nada que testear.')
  process.exit(0)
}

const credsRaw = readFileSync(credsPath, 'utf-8')
const creds = JSON.parse(credsRaw)

console.log('--- Datos del bot desde creds.json ---')
console.log('user.id:', creds.me?.id)
console.log('user.lid:', creds.me?.lid)
console.log('user.name:', creds.me?.name)
console.log()

// 2. Importar el módulo groups y probar la normalización
const { normalizeJid, getBotJidVariants } = await import('../lib/groups.ts')

// Mock del socket: sólo nos interesa user.id, user.lid, user.phoneNumber
const mockSock = {
  user: {
    id: creds.me?.id,
    lid: creds.me?.lid,
    phoneNumber: undefined  // No está en creds, lo dejamos undefined
  }
} as any

const variants = getBotJidVariants(mockSock)
console.log('--- Variantes de JID del bot generadas ---')
variants.forEach(v => console.log('  -', v))
console.log()

// 3. Test: crear un grupo mock donde el bot aparece como LID (caso típico)
const BOT_LID_NORMALIZED = normalizeJid(creds.me?.lid)
const BOT_ID_NORMALIZED = normalizeJid(creds.me?.id)

console.log('--- LID normalizado del bot ---')
console.log('  LID normalizado:', BOT_LID_NORMALIZED)
console.log('  ID normalizado:', BOT_ID_NORMALIZED)
console.log()

// 4. Mock de un grupo donde el bot es superadmin y aparece con su LID
const mockGroupAdmin = {
  id: '1203630001@g.us',
  subject: 'Grupo Test Admin (bot es superadmin)',
  participants: [
    { id: BOT_LID_NORMALIZED, admin: 'superadmin' },
    { id: '276772692222150@lid', admin: 'admin' }
  ]
}

// 5. Mock de un grupo donde el bot no es admin
const mockGroupMember = {
  id: '1203630002@g.us',
  subject: 'Grupo Test No Admin',
  participants: [
    { id: BOT_ID_NORMALIZED, admin: null },
    { id: '8888888888@s.whatsapp.net', admin: 'admin' }
  ]
}

// 6. Función isBotAdminOfGroup (sin sock.isGroupAdmin nativo, fallback manual)
const { isBotAdminOfGroup } = await import('../lib/groups.ts')

console.log('--- Tests de matching ---')
let pass = 0, fail = 0

// Test 1: bot es superadmin (vía LID)
const r1 = await isBotAdminOfGroup(mockSock, mockGroupAdmin as any)
const s1 = r1 === true ? 'PASS' : 'FAIL'
if (s1 === 'PASS') pass++; else fail++
console.log(`[${s1}] Grupo con bot como superadmin (LID): ${r1} (esperado: true)`)

// Test 2: bot no es admin
const r2 = await isBotAdminOfGroup(mockSock, mockGroupMember as any)
const s2 = r2 === false ? 'PASS' : 'FAIL'
if (s2 === 'PASS') pass++; else fail++
console.log(`[${s2}] Grupo con bot como miembro (sin admin): ${r2} (esperado: false)`)

// 7. Test extractChannelInfo con shapes reales del log
console.log()
console.log('--- Tests de canales ---')

const { extractChannelInfo } = await import('../lib/newsletters.ts')

// Shape observado en logs del usuario
const mockChannel1 = {
  id: '120363190306800246@newsletter',
  state: 'ACTIVE',
  thread_metadata: {
    name: { text: 'Mi Canal Real' },
    creation_time: 1234567890
  },
  viewer_metadata: { role: 'ADMIN' }
}

const info1 = extractChannelInfo(mockChannel1)
const s3 = info1.isAdmin === true && info1.name !== '(canal sin nombre)' ? 'PASS' : 'FAIL'
if (s3 === 'PASS') pass++; else fail++
console.log(`[${s3}] Canal con name como objeto {text: "Mi Canal Real"}:`)
console.log(`   isAdmin=${info1.isAdmin}, name="${info1.name}", role=${info1.role}`)

// Shape alternativo: name como string directo
const mockChannel2 = {
  id: '120363xxx@newsletter',
  thread_metadata: {
    name: 'Canal String Directo',
    creation_time: 1234567890
  },
  viewer_metadata: { role: 'SUBSCRIBER' }
}
const info2 = extractChannelInfo(mockChannel2)
const s4 = info2.isAdmin === false && info2.name === 'Canal String Directo' ? 'PASS' : 'FAIL'
if (s4 === 'PASS') pass++; else fail++
console.log(`[${s4}] Canal con name como string directo:`)
console.log(`   isAdmin=${info2.isAdmin}, name="${info2.name}", role=${info2.role}`)

// Canal sin name en thread_metadata
const mockChannel3 = {
  id: '120363yyy@newsletter',
  state: 'ACTIVE',
  viewer_metadata: { role: 'GUEST' }
}
const info3 = extractChannelInfo(mockChannel3)
const s5 = info3.name === '(canal sin nombre)' && info3.role === 'GUEST' ? 'PASS' : 'FAIL'
if (s5 === 'PASS') pass++; else fail++
console.log(`[${s5}] Canal sin name en thread_metadata:`)
console.log(`   isAdmin=${info3.isAdmin}, name="${info3.name}", role=${info3.role}`)

// Canal con campos buffer/objeto (debe safeStr fallback)
const mockChannel4 = {
  id: '120363zzz@newsletter',
  name: Buffer.from('Canal Buffer'),
  thread_metadata: { creation_time: 123 },
  viewer_metadata: { role: 'OWNER' }
}
const info4 = extractChannelInfo(mockChannel4 as any)
const s6 = info4.jid === '120363zzz@newsletter' && info4.isAdmin === true ? 'PASS' : 'FAIL'
if (s6 === 'PASS') pass++; else fail++
console.log(`[${s6}] Canal con name como Buffer (no debe crashear):`)
console.log(`   jid="${info4.jid}", isAdmin=${info4.isAdmin}, name="${info4.name}"`)

console.log()
console.log(`=== Resultados: ${pass} PASS, ${fail} FAIL ===`)
if (fail > 0) {
  console.error('❌ Hay tests fallando.')
  process.exit(1)
} else {
  console.log('✅ Todos los tests pasaron.')
}
