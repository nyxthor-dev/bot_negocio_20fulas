/**
 * Deduplicación de destinos entre cuentas.
 *
 * Cuando el panel tiene varias cuentas de WhatsApp registradas es habitual
 * que dos o más estén en el MISMO grupo o canal. Si cada cuenta envía el
 * mensaje a ese destino, el grupo recibe el mensaje duplicado (uno por
 * cuenta). Esta utilidad deja cada destino asignado a UNA sola cuenta.
 *
 * ¿Quién se queda cada destino?
 *  1. Si hay un mapa de elección (assign: { jid → accountId }) y la cuenta
 *     indicada participa en el envío con ese destino, esa cuenta se queda.
 *  2. Si no, el primer item en el orden de envío (determinista y predecible,
 *     comportamiento por defecto de la v3.3).
 *
 * La usan tanto la publicación inmediata (POST /api/publish con items por
 * cuenta) como el scheduler (mensajes de una programación), para que el
 * comportamiento sea idéntico sin importar el origen del envío.
 */

export interface DedupeInput {
  accountId: number
  jids: string[]
}

export interface DedupeSkipped {
  accountId: number
  jid: string
  /** Cuenta que conserva el envío de ese destino. */
  keptByAccountId: number
}

export interface DedupeResult<T> {
  /** Copia de los items con sus jids ya deduplicados (mismo orden). */
  items: Array<T & DedupeInput>
  /** Destinos quitados por estar repetidos entre cuentas. */
  skipped: DedupeSkipped[]
}

/**
 * Quita de los items los jids repetidos entre cuentas.
 *
 * @param items  Uno por cuenta, con sus destinos.
 * @param assign Mapa opcional { jid → accountId } con la cuenta elegida por
 *               el usuario. Las entradas inválidas (cuenta que no participa,
 *               o que no tiene ese destino entre sus jids) se ignoran y caen
 *               al fallback determinista.
 *
 * No muta los items de entrada (devuelve copias con el array de jids nuevo).
 */
export function dedupeCrossAccount<T extends DedupeInput>(
  items: T[],
  assign?: Record<string, number> | null
): DedupeResult<T> {
  const out = items.map(item => ({ ...item, jids: [...item.jids] }))
  const skipped: DedupeSkipped[] = []

  // Primer item que contiene cada jid (fallback determinista).
  const firstByJid = new Map<string, number>()
  out.forEach((item, idx) => {
    for (const jid of item.jids) {
      if (!firstByJid.has(jid)) firstByJid.set(jid, idx)
    }
  })

  // ¿El jid aparece en más de una cuenta? (si no, no hay dedupe posible)
  const countByJid = new Map<string, number>()
  for (const item of out) {
    for (const jid of new Set(item.jids)) {
      countByJid.set(jid, (countByJid.get(jid) ?? 0) + 1)
    }
  }

  for (let idx = 0; idx < out.length; idx++) {
    const item = out[idx]
    const keep: string[] = []
    const seenInItem = new Set<string>()

    for (const jid of item.jids) {
      // Duplicado dentro del MISMO item: se elimina en silencio.
      if (seenInItem.has(jid)) continue
      seenInItem.add(jid)

      let ownerIdx = firstByJid.get(jid)!

      // Elección del usuario: la cuenta asignada se queda el destino.
      const chosen = assign ? assign[jid] : undefined
      if (countByJid.get(jid)! > 1 && chosen !== undefined && Number.isInteger(chosen)) {
        const chosenIdx = out.findIndex(it => it.accountId === chosen && it.jids.includes(jid))
        if (chosenIdx >= 0) ownerIdx = chosenIdx
      }

      if (ownerIdx === idx) {
        keep.push(jid)
      } else {
        skipped.push({ accountId: item.accountId, jid, keptByAccountId: out[ownerIdx].accountId })
      }
    }
    item.jids = keep
  }

  return { items: out, skipped }
}
