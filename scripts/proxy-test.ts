/**
 * Test: arrancar el panel y verificar que responde HTTP.
 * No usa el bot de WhatsApp.
 */
import { startWebServer, stopWebServer } from '../web/server.ts'
import { openDatabase, closeDatabase } from '../lib/db.ts'

async function main() {
  openDatabase()

  console.log('--- Arrancando panel en 127.0.0.1:41234 ---')
  const { url } = await startWebServer({ host: '127.0.0.1', port: 41234 })

  // Esperar a que escuche
  await new Promise(r => setTimeout(r, 500))

  console.log('--- Haciendo GET / ---')
  const res = await fetch(url + '/')
  console.log('Status:', res.status)
  const html = await res.text()
  console.log('HTML length:', html.length)
  console.log('Contiene "Publisher Manager":', html.includes('Publisher Manager'))

  console.log('--- Cerrando servidor ---')
  await stopWebServer()
  console.log('OK: servidor cerrado')

  // Cerrar DB con un pequeño delay para evitar el crash de better-sqlite3 cleanup
  setTimeout(() => {
    closeDatabase()
    console.log('✅ Test OK')
    process.exit(0)
  }, 100)
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
