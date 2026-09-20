/**
 * CLI para crear o resetear administradores del panel sin entrar al mismo.
 *
 *   tsx scripts/create-admin.ts <usuario> <contraseña> [--superadmin]
 *   tsx scripts/create-admin.ts <usuario> <contraseña> --reset
 *
 * --reset    cambia la contraseña de un usuario existente (revoca sus sesiones)
 * --superadmin  crea el usuario con rol superadmin
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { openDatabase, closeDatabase } from '../lib/db.ts'
import { createAdmin, resetAdminPassword, ensureAdminCredentials, printCredentialsBox } from '../lib/adminAuth.ts'
import { silenceConsoleNoise } from '../lib/consoleFilter.ts'

silenceConsoleNoise()

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = resolve(__dirname, '..', 'data', 'bot.db')

async function main() {
  const args = process.argv.slice(2)
  const flags = args.filter(a => a.startsWith('--'))
  const positional = args.filter(a => !a.startsWith('--'))

  if (positional.length < 2) {
    console.log('Uso: tsx scripts/create-admin.ts <usuario> <contraseña> [--superadmin] [--reset]')
    process.exit(1)
  }

  const [username, password] = positional
  const isReset = flags.includes('--reset')
  const role = flags.includes('--superadmin') ? 'superadmin' : 'admin'

  openDatabase(DB_PATH)

  // Si no hay ningún admin, aseguramos el superadmin inicial igual que al arrancar
  const bootstrap = ensureAdminCredentials()
  if (bootstrap) {
    printCredentialsBox(bootstrap)
    console.log('(Ese es el superadmin inicial generado. El usuario pedido se agrega aparte.)\n')
  }

  if (isReset) {
    const result = resetAdminPassword(username, password)
    if (!result.ok) {
      console.error('✗ ' + result.error)
      closeDatabase()
      process.exit(1)
    }
    console.log(`✓ Contraseña de "${username}" actualizada (sus sesiones quedaron revocadas).`)
  } else {
    const result = createAdmin(username, password, role)
    if (!result.ok) {
      console.error('✗ ' + result.error)
      closeDatabase()
      process.exit(1)
    }
    console.log(`✓ Admin "${username}" creado con rol ${role}.`)
  }

  closeDatabase()
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
