/* Publisher Manager — Lógica del panel web (mobile-first, fusión v2 + v3) */

const API = '/api'

const state = {
  admin: null,
  accounts: [],
  activeAccountId: null,    // cuenta seleccionada en los chips de Destinos
  groupsByAccount: {},      // account_id -> { groups: [], newsletters: [] }
  groupsLoaded: {},         // account_id -> true si ya se pidieron al server
  selectedJids: {},         // account_id -> Set(jids)
  dupeChoice: {},           // jid -> account_id elegido para destinos duplicados (Publicar)
  activeTab: 'groups',      // grupos vs canales (destinos)
  publishing: false,
  mediaFile: null,          // File local (multimedia adjunta)
  publishMedia: null,       // multimedia ya subida al server { id, url, media_type, ... }
  uploading: false,
  templates: [],
  schedules: [],
  editingScheduleId: null,  // si se está editando una programación existente
  schedTimesSimple: [],     // horarios del día del modo Programar simplificado (minutos 0-1439)
  linkingAccountId: null,
  linkPollTimer: null,
  statusPollTimer: null,
  activeView: 'publish',
  activePubSubtab: 'publish',
  activeHistSubtab: 'history',
  sendMode: 'now'           // 'now' | 'schedule' — toggle del formulario unificado
}

/* ---------- Helpers ---------- */

async function api (path, options = {}) {
  const fetchOpts = { ...options }
  if (fetchOpts.body !== undefined && !(fetchOpts.body instanceof FormData)) {
    fetchOpts.headers = { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) }
  } else if (!fetchOpts.body) {
    fetchOpts.headers = { ...(fetchOpts.headers || {}) }
  }
  const res = await fetch(API + path, fetchOpts)
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/status') {
    showLogin()
    throw new Error('Sesión expirada')
  }
  if (!res.ok) {
    throw new Error(data.error || data.details || `HTTP ${res.status}`)
  }
  return data
}

function toast (msg, type = '') {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = 'toast' + (type ? ` toast--${type}` : '')
  el.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.hidden = true }, 3500)
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function formatTimestamp (ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return d.toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

function minutesToHHMM (mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
}

function hhmmToMinutes (hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null
  return h * 60 + m
}

const MEDIA_META = {
  image:    { icon: '🖼️', label: 'Imagen' },
  video:    { icon: '🎬', label: 'Video' },
  audio:    { icon: '🎵', label: 'Audio' },
  document: { icon: '📄', label: 'Documento' },
  sticker:  { icon: '✨', label: 'Sticker' }
}

function mediaBadgeHtml (media) {
  if (!media) return ''
  const meta = MEDIA_META[media.media_type] || { icon: '📎', label: String(media.media_type) }
  return `<span class="dec-badge">${meta.icon} ${meta.label}</span>`
}

function mediaPreviewHtml (media) {
  if (!media) return ''
  const meta = MEDIA_META[media.media_type] || { icon: '📎', label: String(media.media_type) }
  if (media.media_type === 'image' || media.media_type === 'sticker') {
    return `<img src="${media.url}" alt="${escapeHtml(media.file_name)}" class="media-preview__img" />`
  }
  if (media.media_type === 'video') {
    return `<video src="${media.url}" controls class="media-preview__video"></video>`
  }
  if (media.media_type === 'audio') {
    return `<audio src="${media.url}" controls class="media-preview__audio"></audio>`
  }
  return `<div class="media-preview__file">${meta.icon} ${escapeHtml(media.file_name || meta.label)}</div>`
}

/** Sube un File adjunto al server (base64) y devuelve el objeto media. */
async function uploadMediaFile (file) {
  if (!file) return null
  if (file.size > 50 * 1024 * 1024) {
    toast('El archivo supera los 50 MB.', 'error')
    return null
  }
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'))
    reader.readAsDataURL(file)
  })
  const stateEl = document.getElementById('upload-state')
  stateEl.hidden = false
  state.uploading = true
  try {
    return await api('/media', {
      method: 'POST',
      body: JSON.stringify({
        base64,
        mime_type: file.type || 'application/octet-stream',
        file_name: file.name
      })
    })
  } catch (err) {
    toast('Error subiendo multimedia: ' + err.message, 'error')
    return null
  } finally {
    state.uploading = false
    stateEl.hidden = true
  }
}

const DOW_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

function scheduleLabel (s) {
  if (s.sched_type === 'once') return 'Una vez · ' + formatTimestamp(s.scheduled_at)
  if (s.sched_type === 'interval') {
    let label = 'Cada ' + (s.interval_minutes ?? '?') + ' min'
    if (s.window_start != null && s.window_end != null) {
      label += ' · de ' + minutesToHHMM(s.window_start) + ' a ' + minutesToHHMM(s.window_end)
    }
    return label
  }
  const times = Array.isArray(s.recur_times) && s.recur_times.length > 0
    ? s.recur_times
    : (s.recur_time != null ? [s.recur_time] : [])
  const timesLabel = times.length > 0
    ? (times.length === 1 ? minutesToHHMM(times[0]) : times.length + ' veces/día (' + times.map(t => minutesToHHMM(t)).join(', ') + ')')
    : '?'
  if (s.sched_type === 'daily') return 'Todos los días · ' + timesLabel
  if (s.sched_type === 'weekly') return 'Cada ' + (DOW_NAMES[s.recur_dow] || '?') + ' · ' + timesLabel
  if (s.sched_type === 'monthly') return 'Día ' + s.recur_dom + ' de cada mes · ' + timesLabel
  return '?'
}

const STATUS_META = {
  pending:     { label: 'Pendiente',   cls: 'muted' },
  linking:     { label: 'Vinculando',  cls: 'warn' },
  connected:   { label: 'Conectada',   cls: 'ok' },
  disconnected:{ label: 'Desconectada',cls: 'warn' },
  logged_out:  { label: 'Sin sesión',  cls: 'danger' }
}

function statusBadge (status) {
  const meta = STATUS_META[status] || { label: status, cls: 'muted' }
  return `<span class="badge badge--${meta.cls}">${meta.label}</span>`
}

function accountLabel (accountId) {
  const a = state.accounts.find(x => x.id === accountId)
  return a ? a.label : 'Cuenta ' + accountId
}

function findName (jid) {
  for (const acc of state.accounts) {
    const cache = state.groupsByAccount[acc.id]
    if (!cache) continue
    const g = (cache.groups || []).find(x => x.jid === jid)
    if (g) return g.name
    const n = (cache.newsletters || []).find(x => x.jid === jid)
    if (n) return n.name
  }
  return null
}

function confirmDialog (msg) {
  return window.confirm(msg)
}

/* ---------- Autenticación ---------- */

function showLogin () {
  stopStatusPolling()
  stopLinkPolling()
  document.getElementById('login-screen').hidden = false
  document.getElementById('app').hidden = true
}

function showApp () {
  document.getElementById('login-screen').hidden = true
  document.getElementById('app').hidden = false
  document.getElementById('sidebar-username').textContent = state.admin ? state.admin.username : ''
  const isSuper = state.admin && state.admin.role === 'superadmin'
  document.getElementById('tab-admins').style.display = isSuper ? '' : 'none'
  const adminsPanel = document.getElementById('subtab-admins')
  if (!isSuper && state.activeHistSubtab === 'admins') {
    switchHistSubtab('history')
  } else {
    adminsPanel.hidden = !isSuper ? true : adminsPanel.hidden
  }
}

async function checkSession () {
  try {
    const data = await api('/auth/status')
    state.admin = data.admin
    showApp()
    await afterLogin()
  } catch {
    showLogin()
  }
}

async function doLogin (username, password) {
  const errEl = document.getElementById('login-error')
  const btn = document.getElementById('login-submit')
  const btnText = btn.querySelector('.btn__text')
  const btnSpinner = btn.querySelector('.btn__spinner')
  errEl.hidden = true
  btn.disabled = true
  btnText.textContent = 'Entrando…'
  btnSpinner.hidden = false
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    })
    state.admin = data.admin
    showApp()
    await afterLogin()
  } catch (err) {
    errEl.textContent = err.message
    errEl.hidden = false
  } finally {
    btn.disabled = false
    btnText.textContent = 'Entrar'
    btnSpinner.hidden = true
  }
}

async function doLogout () {
  stopStatusPolling()
  stopLinkPolling()
  try {
    await api('/auth/logout', { method: 'POST' })
  } catch { /* la sesión pudo haber expirado igual */ }
  state.admin = null
  state.accounts = []
  state.groupsByAccount = {}
  state.groupsLoaded = {}
  state.selectedJids = {}
  state.activeAccountId = null
  state.publishMedia = null
  state.mediaFile = null
  showLogin()
}

/* ---------- Navegación entre vistas (sidebar de 2 elementos) ---------- */

function switchView (viewName) {
  state.activeView = viewName
  document.querySelectorAll('.nav-item, .bottom-nav__item').forEach(n => n.classList.remove('active'))
  document.querySelectorAll(`[data-view="${viewName}"]`).forEach(n => n.classList.add('active'))
  document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'))
  document.getElementById('view-' + viewName).classList.add('view--active')

  // El FAB de Publicar sólo corresponde a la vista Publicar en modo "ahora"
  const showFab = viewName === 'publish' && state.sendMode === 'now'
  document.getElementById('fab-publish').style.display = showFab ? '' : 'none'

  // Carga perezosa del contenido de la vista
  if (viewName === 'publish') {
    switchPubSubtab(state.activePubSubtab)
  } else if (viewName === 'history') {
    switchHistSubtab(state.activeHistSubtab)
  }
}

function switchPubSubtab (subtab) {
  state.activePubSubtab = subtab
  document.querySelectorAll('#publish-subtabs .tab').forEach(t => t.classList.toggle('active', t.dataset.subtab === subtab))
  document.getElementById('subtab-publish').hidden = subtab !== 'publish'
  document.getElementById('subtab-templates').hidden = subtab !== 'templates'
  // La lista de programaciones vive ahora DENTRO de la vista Publicar
  // (siempre visible abajo del formulario), así que se muestra con su contenedor.
  document.getElementById('schedules-list-card').style.display = subtab === 'publish' ? '' : 'none'

  // El FAB de Publicar sólo corresponde al sub-tab de Publicar (modo "ahora")
  const showFab = subtab === 'publish' && state.sendMode === 'now'
  document.getElementById('fab-publish').style.display = showFab ? '' : 'none'

  if (subtab === 'templates') loadTemplates()
  // Las programaciones se cargan al entrar a Publicar (la lista siempre visible).
  if (subtab === 'publish') loadSchedules()
}

function switchHistSubtab (subtab) {
  state.activeHistSubtab = subtab
  document.querySelectorAll('#history-subtabs .tab').forEach(t => t.classList.toggle('active', t.dataset.subtab === subtab))
  document.getElementById('subtab-history').hidden = subtab !== 'history'
  document.getElementById('subtab-accounts').hidden = subtab !== 'accounts'
  const isSuper = state.admin && state.admin.role === 'superadmin'
  document.getElementById('subtab-admins').hidden = subtab !== 'admins' || !isSuper

  if (subtab === 'history') loadHistory()
  if (subtab === 'accounts') { renderAccountsList(); }
  if (subtab === 'admins' && isSuper) loadAdmins()
}

document.querySelectorAll('[data-view]').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault()
    switchView(item.dataset.view)
  })
})

document.querySelectorAll('#publish-subtabs .tab').forEach(tab => {
  tab.addEventListener('click', () => switchPubSubtab(tab.dataset.subtab))
})

document.querySelectorAll('#history-subtabs .tab').forEach(tab => {
  tab.addEventListener('click', () => switchHistSubtab(tab.dataset.subtab))
})

/* ---------- Cuentas: carga y estado ---------- */

async function loadAccounts (force = false) {
  const data = await api('/accounts')
  state.accounts = data.accounts || []
  updateBotStatus()
  renderAccountChips()
  updateAccountsCount()

  // Cargar grupos/canales cacheados de cada cuenta (una sola vez salvo force)
  for (const acc of state.accounts) {
    if (force || !state.groupsLoaded[acc.id]) {
      await loadGroupsForAccount(acc.id)
    }
  }

  // Seleccionar cuenta activa: la anterior, o la primera conectada, o la primera
  const stillThere = state.accounts.some(a => a.id === state.activeAccountId)
  if (!stillThere) {
    const connected = state.accounts.find(a => a.status === 'connected')
    state.activeAccountId = (connected || state.accounts[0] || {}).id ?? null
    renderTargets()
  }
}

async function loadGroupsForAccount (accountId) {
  try {
    const [g, n] = await Promise.all([
      api(`/groups?account_id=${accountId}`),
      api(`/newsletters?account_id=${accountId}`)
    ])
    state.groupsByAccount[accountId] = {
      groups: g.groups || [],
      newsletters: n.newsletters || []
    }
    state.groupsLoaded[accountId] = true
  } catch (err) {
    state.groupsByAccount[accountId] = { groups: [], newsletters: [] }
  }
  renderTargets()
}

function updateBotStatus () {
  // El mismo estado se refleja en el footer del sidebar (desktop)
  const el = document.getElementById('bot-status-desktop')
  if (!el) return
  const dot = el.querySelector('.status__dot')
  const text = el.querySelector('.status__text')
  const connected = state.accounts.filter(a => a.status === 'connected').length
  if (connected > 0) {
    dot.className = 'status__dot status__dot--ok'
    text.textContent = `${connected} cuenta${connected !== 1 ? 's' : ''} activa${connected !== 1 ? 's' : ''}`
  } else if (state.accounts.length > 0) {
    dot.className = 'status__dot status__dot--pending'
    text.textContent = 'Sin cuentas conectadas'
  } else {
    dot.className = 'status__dot status__dot--pending'
    text.textContent = 'Sin cuentas'
  }
}

function updateAccountsCount () {
  const el = document.getElementById('tab-accounts-count')
  if (el) el.textContent = String(state.accounts.length)
}

function startStatusPolling () {
  stopStatusPolling()
  state.statusPollTimer = setInterval(async () => {
    if (!state.admin) return
    try {
      const data = await api('/accounts')
      const prev = JSON.stringify(state.accounts.map(a => [a.id, a.status]))
      state.accounts = data.accounts || []
      const next = JSON.stringify(state.accounts.map(a => [a.id, a.status]))
      updateBotStatus()
      updateAccountsCount()
      if (prev !== next) {
        renderAccountChips()
        renderTargets()
        if (state.activeHistSubtab === 'accounts') renderAccountsList()
      }
    } catch { /* silencioso: el 401 ya redirige a login */ }
  }, 5000)
}

function stopStatusPolling () {
  if (state.statusPollTimer) {
    clearInterval(state.statusPollTimer)
    state.statusPollTimer = null
  }
}

/* ---------- Chips de cuenta (selector de Destinos) ---------- */

function renderAccountChips () {
  const box = document.getElementById('account-chips')
  if (!state.admin || state.accounts.length === 0) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false

  box.innerHTML = state.accounts.map(acc => {
    const active = acc.id === state.activeAccountId
    const dotCls = acc.status === 'connected' ? 'ok' : (acc.status === 'linking' ? 'pending' : 'error')
    return `
      <button class="account-chip ${active ? 'account-chip--active' : ''}" data-account="${acc.id}" type="button">
        <span class="account-chip__dot status__dot status__dot--${dotCls}"></span>
        <span>${escapeHtml(acc.label)}</span>
      </button>
    `
  }).join('')

  box.querySelectorAll('.account-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      state.activeAccountId = Number(chip.dataset.account)
      renderAccountChips()
      renderTargets()
    })
  })
}

/* ---------- Tabs: grupos vs canales (dentro de Destinos) ---------- */

document.querySelectorAll('.tab[data-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab
    state.activeTab = target
    document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    renderTargets()
  })
})

/* ---------- Elección de cuenta para destinos duplicados ---------- */

/** Cuentas que tienen el jid seleccionado (en el orden del panel). */
function accountsWithJid (jid) {
  return state.accounts.filter(a => state.selectedJids[a.id] && state.selectedJids[a.id].has(jid))
}

/** HTML del selector inline de "qué cuenta envía" para un destino duplicado. */
function dupePickerHtml (jid, options, chosenId) {
  const opts = options.map(o =>
    `<option value="${o.id}" ${o.id === chosenId ? 'selected' : ''}>${escapeHtml(o.label)}${o.warn ? ' · ⚠ desconectada' : ''}</option>`
  ).join('')
  return `
    <div class="dupe-picker" data-dupe-jid="${escapeHtml(jid)}">
      <span class="dupe-picker__label">⇄ Enviar con</span>
      <select class="dupe-picker__select" aria-label="Cuenta que envía a este destino">${opts}</select>
    </div>
  `
}

/** Conecta los selectores de elección de un contenedor. */
function bindDupePickers (container, onChange) {
  container.querySelectorAll('.dupe-picker').forEach(p => {
    const select = p.querySelector('select')
    select.addEventListener('change', () => onChange(p.dataset.dupeJid, Number(select.value)))
  })
}

/* ---------- Renderizado de destinos según tab activa ---------- */

function renderTargets () {
  const listEl = document.getElementById('targets-list')
  const countEl = document.getElementById('targets-count')
  const tabGroupsCount = document.getElementById('tab-groups-count')
  const tabNewslettersCount = document.getElementById('tab-newsletters-count')
  if (!state.admin) return

  // Sin cuentas todavía
  if (state.accounts.length === 0) {
    tabGroupsCount.textContent = '0'
    tabNewslettersCount.textContent = '0'
    countEl.textContent = '0'
    listEl.innerHTML = '<div class="empty">No tenés cuentas todavía.<br>Andá a <strong>Historial → Cuentas</strong> para agregar tu primer número de WhatsApp.</div>'
    updatePublishButton()
    return
  }

  const acc = state.accounts.find(a => a.id === state.activeAccountId) || state.accounts[0]
  if (!acc) return
  state.activeAccountId = acc.id
  if (!state.selectedJids[acc.id]) state.selectedJids[acc.id] = new Set()

  const cache = state.groupsByAccount[acc.id] || { groups: [], newsletters: [] }
  const groups = cache.groups || []
  const newsletters = cache.newsletters || []

  tabGroupsCount.textContent = String(groups.length)
  tabNewslettersCount.textContent = String(newsletters.length)

  const currentList = state.activeTab === 'groups' ? groups : newsletters
  const label = state.activeTab === 'groups' ? 'grupos' : 'canales'

  if (currentList.length === 0) {
    const refreshBtn = state.activeTab === 'groups' ? '👥 Grupos' : '📢 Canales'
    const msg = state.activeTab === 'groups'
      ? `No hay ${label} en el cache para ${escapeHtml(acc.label)}.`
      : `No hay ${label} admin en el cache para ${escapeHtml(acc.label)}.`
    listEl.innerHTML = `<div class="empty">${msg}<br><br>Pulsá <strong>${refreshBtn}</strong> arriba para sincronizar.</div>`
    countEl.textContent = '0'
    updatePublishButton()
    return
  }

  const groupsAdmin = groups.filter(g => g.is_admin).length
  if (state.activeTab === 'groups') {
    countEl.textContent = groups.length === groupsAdmin
      ? `${groups.length}`
      : `${groups.length} · ${groupsAdmin} admin`
  } else {
    countEl.textContent = `${newsletters.length} admin`
  }

  listEl.innerHTML = currentList.map(item => {
    const jid = item.jid
    const name = item.name || '(sin nombre)'
    const isAdmin = !!item.is_admin
    const isOwner = !!item.is_owner
    const icon = state.activeTab === 'groups' ? '👥' : '📢'
    const tagClass = state.activeTab === 'groups' ? 'target-item__tag--group' : 'target-item__tag--channel'
    const tagText = state.activeTab === 'groups' ? 'GRUPO' : 'CANAL'
    const adminBadge = state.activeTab === 'groups'
      ? (isAdmin
          ? `<span class="target-item__admin-badge target-item__admin-badge--admin">${isOwner ? '👑 OWNER' : '⭐ ADMIN'}</span>`
          : (item.can_send === false
              ? '<span class="target-item__admin-badge target-item__admin-badge--member">🚫 SOLO ADMINS</span>'
              : '<span class="target-item__admin-badge target-item__admin-badge--member">👤 MIEMBRO</span>'))
      : ''
    // ¿El destino está seleccionado en varias cuentas? → selector de quién envía.
    const dupeAccounts = accountsWithJid(jid)
    let dupeControl = ''
    if (dupeAccounts.length >= 2) {
      const validIds = new Set(dupeAccounts.map(a => a.id))
      if (!(jid in state.dupeChoice) || !validIds.has(state.dupeChoice[jid])) {
        state.dupeChoice[jid] = dupeAccounts[0].id
      }
      dupeControl = dupePickerHtml(
        jid,
        dupeAccounts.map(a => ({ id: a.id, label: a.label, warn: a.status !== 'connected' })),
        state.dupeChoice[jid]
      )
    } else {
      // Aviso informativo: otra cuenta ya tiene este destino elegido.
      const dupAcc = state.accounts.find(a => a.id !== acc.id && state.selectedJids[a.id] && state.selectedJids[a.id].has(jid))
      dupeControl = dupAcc
        ? `<span class="target-item__dupe" title="Otra cuenta ya tiene este destino: al publicar, sólo una lo enviará.">⇄ ya en ${escapeHtml(dupAcc.label)}</span>`
        : ''
    }
    return `
      <div class="target-row">
        <label class="target-item">
          <input type="checkbox" data-jid="${escapeHtml(jid)}" ${state.selectedJids[acc.id].has(jid) ? 'checked' : ''} />
          <div style="flex:1; min-width:0;">
            <div class="target-item__name">
              <span class="target-item__icon">${icon}</span>
              ${escapeHtml(name)}
              <span class="target-item__tag ${tagClass}">${tagText}</span>
              ${adminBadge}
            </div>
            <div class="target-item__jid">${escapeHtml(jid)}</div>
          </div>
        </label>
        ${dupeControl}
      </div>
    `
  }).join('')

  bindDupePickers(listEl, (jid, accId) => {
    state.dupeChoice[jid] = accId
  })

  listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const jid = cb.dataset.jid
      if (cb.checked) state.selectedJids[acc.id].add(jid)
      else state.selectedJids[acc.id].delete(jid)
      // Poda: si el jid dejó de estar duplicado, su elección ya no aplica
      if (state.dupeChoice[jid] && accountsWithJid(jid).length < 2) {
        delete state.dupeChoice[jid]
      }
      // Si cambió el estado de duplicado del jid (apareció o desapareció el
      // "⇄ Enviar con"), refrescar la lista para no dejar un picker/chip
      // stale. En el caso común (grupo normal, 1 cuenta) NO se re-renderiza:
      // la lista queda estable y sin saltos de scroll.
      const hadPicker = !!listEl.querySelector(`.dupe-picker[data-dupe-jid="${window.CSS && CSS.escape ? CSS.escape(jid) : jid}"]`)
      const isDupe = accountsWithJid(jid).length >= 2
      if (isDupe || hadPicker) {
        renderTargets()
        return
      }
      updatePublishButton()
      // Los avisos "⇄ ya en ..." de esta lista dependen de la selección de
      // OTRAS cuentas (que no cambia acá), así que no hace falta re-render:
      // se refrescan solos al cambiar de cuenta con los chips.
    })
  })

  const selectAll = document.getElementById('select-all')
  selectAll.checked = currentList.length > 0 && currentList.every(g => state.selectedJids[acc.id].has(g.jid))
  updatePublishButton()
}

/* ---------- Select all ---------- */

document.getElementById('select-all').addEventListener('change', e => {
  const acc = state.accounts.find(a => a.id === state.activeAccountId)
  if (!acc) return
  const cache = state.groupsByAccount[acc.id] || { groups: [], newsletters: [] }
  const currentList = state.activeTab === 'groups' ? (cache.groups || []) : (cache.newsletters || [])
  if (!state.selectedJids[acc.id]) state.selectedJids[acc.id] = new Set()
  if (e.target.checked) {
    currentList.forEach(g => state.selectedJids[acc.id].add(g.jid))
  } else {
    currentList.forEach(g => state.selectedJids[acc.id].delete(g.jid))
  }
  renderTargets()
})

/* ---------- Texto ---------- */

document.getElementById('publish-text').addEventListener('input', e => {
  const len = e.target.value.length
  document.getElementById('char-count').textContent = `${len} caracter${len !== 1 ? 'es' : ''}`
  updatePublishButton()
})

/* ---------- Carga y refresco de grupos/canales ---------- */

async function refreshGroups () {
  const btn = document.getElementById('btn-refresh-groups')
  const originalText = btn.textContent
  btn.disabled = true
  btn.textContent = '…'
  try {
    const accId = state.activeAccountId
    if (!accId) throw new Error('No hay cuenta seleccionada.')
    const data = await api('/groups/refresh', { method: 'POST', body: JSON.stringify({ account_id: accId }) })
    await loadGroupsForAccount(accId)
    toast(`Sincronizados ${data.total ?? (data.groups || []).length} grupos de ${accountLabel(accId)}.`, 'success')
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = originalText
  }
}

async function refreshNewsletters () {
  const btn = document.getElementById('btn-refresh-newsletters')
  const originalText = btn.textContent
  btn.disabled = true
  btn.textContent = '…'
  try {
    const accId = state.activeAccountId
    if (!accId) throw new Error('No hay cuenta seleccionada.')
    await api('/newsletters/refresh', { method: 'POST', body: JSON.stringify({ account_id: accId }) })
    await loadGroupsForAccount(accId)
    toast(`Canales sincronizados de ${accountLabel(accId)}.`, 'success')
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = originalText
  }
}

document.getElementById('btn-refresh-groups').addEventListener('click', refreshGroups)
document.getElementById('btn-refresh-newsletters').addEventListener('click', refreshNewsletters)

// Mobile sync button (sincroniza grupos y canales de la cuenta activa)
document.getElementById('mobile-sync').addEventListener('click', async () => {
  await Promise.all([refreshGroups(), refreshNewsletters()])
})

/* ---------- Multimedia (misma interfaz simple que los mensajes programados) ---------- */

function setupMediaAttach () {
  const input = document.getElementById('media-input')
  const btn = document.getElementById('btn-attach')
  const removeBtn = document.getElementById('media-remove')

  // Tocar "Adjuntar multimedia" abre el selector de archivos
  btn.addEventListener('click', () => input.click())

  // Change handler — reset value para que change dispare siempre
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) {
      handleFile(input.files[0])
      // Reset crítico para móvil: sin esto, no se puede seleccionar el mismo archivo
      input.value = ''
    }
  })

  // Quitar archivo adjunto
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    clearMedia()
  })
}

function handleFile (file) {
  if (file.size > 50 * 1024 * 1024) {
    toast('Archivo demasiado grande (máx 50MB).', 'error')
    return
  }

  state.mediaFile = file
  renderLocalPreview()
  updatePublishButton()

  // Subir enseguida al server (necesario para publicar y para guardar en plantilla)
  uploadMediaFile(file).then(media => {
    if (media && state.mediaFile === file) {
      state.publishMedia = media
      updatePublishButton()
    } else if (!media && state.mediaFile === file) {
      clearMedia()
    }
  })
}

/** Fila de nombre de archivo + botón Quitar, común a preview local y de server. */
function showAttachMeta (fileName) {
  const nameEl = document.getElementById('attach-name')
  const removeBtn = document.getElementById('media-remove')
  nameEl.textContent = fileName
  nameEl.hidden = false
  removeBtn.hidden = false
}

/** Preview local del File elegido. */
function renderLocalPreview () {
  const file = state.mediaFile
  const preview = document.getElementById('media-preview')
  const imgEl = document.getElementById('preview-img')
  const videoEl = document.getElementById('preview-video')
  const fileEl = document.getElementById('preview-file')
  const filenameEl = document.getElementById('preview-filename')
  const serverEl = document.getElementById('preview-server')

  imgEl.hidden = true
  videoEl.hidden = true
  fileEl.hidden = true
  serverEl.hidden = true
  serverEl.innerHTML = ''

  if (!file) return

  showAttachMeta(`${file.name} · ${(file.size / 1024).toFixed(0)} KB`)

  if (file.type.startsWith('image/')) {
    imgEl.src = createObjectUrlSafe(file, imgEl)
    imgEl.hidden = false
  } else if (file.type.startsWith('video/')) {
    videoEl.src = createObjectUrlSafe(file, videoEl)
    videoEl.hidden = false
  } else {
    filenameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`
    fileEl.hidden = false
  }

  preview.hidden = false
}

/**
 * Crea un blob URL revocando el anterior del mismo elemento: sin esto, cada
 * archivo adjuntado filtra su blob (relevante con videos de decenas de MB).
 */
function createObjectUrlSafe (file, el) {
  if (el.dataset.blobUrl) {
    try { URL.revokeObjectURL(el.dataset.blobUrl) } catch { /* ya revocada */ }
  }
  const url = URL.createObjectURL(file)
  el.dataset.blobUrl = url
  return url
}

/** Muestra como preview una multimedia ya subida (plantilla cargada). */
function renderServerPreview () {
  const media = state.publishMedia
  const preview = document.getElementById('media-preview')
  const imgEl = document.getElementById('preview-img')
  const videoEl = document.getElementById('preview-video')
  const fileEl = document.getElementById('preview-file')
  const serverEl = document.getElementById('preview-server')

  imgEl.hidden = true
  videoEl.hidden = true
  fileEl.hidden = true
  imgEl.src = ''
  videoEl.src = ''

  if (!media) return

  showAttachMeta(media.file_name || 'multimedia adjunta')

  serverEl.innerHTML = mediaPreviewHtml(media)
  serverEl.hidden = false
  preview.hidden = false
}

function clearMedia () {
  state.mediaFile = null
  state.publishMedia = null
  const input = document.getElementById('media-input')
  input.value = ''
  document.getElementById('attach-name').hidden = true
  document.getElementById('attach-name').textContent = ''
  document.getElementById('media-remove').hidden = true
  document.getElementById('media-preview').hidden = true
  // Limpiar URLs para liberar memoria
  document.getElementById('preview-img').src = ''
  document.getElementById('preview-video').src = ''
  const serverEl = document.getElementById('preview-server')
  serverEl.hidden = true
  serverEl.innerHTML = ''
  updatePublishButton()
}

/* ---------- Botón Publicar / Programar (FAB móvil + botón desktop) ---------- */

function updatePublishButton () {
  const text = document.getElementById('publish-text').value.trim()
  const hasMedia = !!state.publishMedia || !!state.mediaFile
  const hasContent = text.length > 0 || hasMedia
  const anyTarget = Object.values(state.selectedJids).some(set => set && set.size > 0)
  // Mientras se sube la multimedia no se puede publicar (faltaria el media_id)
  const disabled = state.publishing || state.uploading || !hasContent || !anyTarget
  // En modo "ahora": el FAB y el botónPublicar ahora se habilitan con el mismo estado.
  document.getElementById('fab-publish').disabled = disabled || state.sendMode !== 'now'
  document.getElementById('btn-publish').disabled = disabled
  // En modo "programar": el botón "Crear programación" usa el mismo criterio
  // (la validación de fecha/hora se hace en submit, no acá).
  const btnSched = document.getElementById('btn-schedule-simple')
  if (btnSched) btnSched.disabled = disabled
}

async function publish () {
  const text = document.getElementById('publish-text').value.trim()
  if (state.uploading) {
    toast('Esperá a que termine de subir la multimedia.', 'error')
    return
  }
  if (!text && !state.publishMedia) {
    toast('Debe haber al menos texto o un archivo multimedia.', 'error')
    return
  }

  // Armar un item por cuenta con destinos seleccionados
  const items = []
  for (const acc of state.accounts) {
    const set = state.selectedJids[acc.id]
    if (set && set.size > 0) {
      items.push({
        account_id: acc.id,
        text,
        target_jids: Array.from(set),
        media_id: state.publishMedia ? state.publishMedia.id : undefined
      })
    }
  }
  if (items.length === 0) {
    toast('Elegí al menos un destino.', 'error')
    return
  }

  // Elección del usuario para destinos duplicados: { jid → account_id }.
  // Sólo se mandan los jids que siguen duplicados entre cuentas; si la
  // elección guardada ya no aplica (esa cuenta ya no lo tiene elegido),
  // cae al primer orden determinista.
  const accountsByJid = new Map()
  for (const acc of state.accounts) {
    const set = state.selectedJids[acc.id]
    if (!set) continue
    for (const jid of set) {
      if (!accountsByJid.has(jid)) accountsByJid.set(jid, [])
      accountsByJid.get(jid).push(acc.id)
    }
  }
  const assign = {}
  for (const [jid, accIds] of accountsByJid) {
    if (accIds.length < 2) continue
    const chosen = state.dupeChoice[jid]
    assign[jid] = accIds.includes(chosen) ? chosen : accIds[0]
  }

  const decorations = {}
  if (document.getElementById('dec-forwarded').checked) decorations.forwarded = true
  items.forEach(i => { if (Object.keys(decorations).length > 0) i.decorations = { ...decorations } })

  const fab = document.getElementById('fab-publish')
  const fabText = fab.querySelector('.fab__text')
  const fabSpinner = fab.querySelector('.fab__spinner')
  const btn = document.getElementById('btn-publish')
  const btnText = btn.querySelector('.btn__text')
  const btnSpinner = btn.querySelector('.btn__spinner')

  state.publishing = true
  fab.disabled = true
  btn.disabled = true
  fabText.textContent = 'Enviando…'
  btnText.textContent = 'Publicando…'
  fabSpinner.hidden = false
  btnSpinner.hidden = false

  const resultsEl = document.getElementById('publish-results')
  resultsEl.hidden = true

  try {
    const data = await api('/publish', {
      method: 'POST',
      body: JSON.stringify({ items, assign: Object.keys(assign).length > 0 ? assign : undefined })
    })
    renderResults(data)
    const skippedNote = data.skipped_total > 0 ? ` · ${data.skipped_total} omitido${data.skipped_total !== 1 ? 's' : ''} (duplicados entre cuentas)` : ''
    toast(`Enviado: ${data.sent}/${data.total} ✓${skippedNote}`, data.failed === 0 ? 'success' : 'error')
  } catch (err) {
    if (err.message !== 'Sesión expirada') {
      toast('Error publicando: ' + err.message, 'error')
    }
  } finally {
    state.publishing = false
    fab.disabled = false
    btn.disabled = false
    fabText.textContent = 'Publicar'
    btnText.textContent = 'Publicar'
    fabSpinner.hidden = true
    btnSpinner.hidden = true
    updatePublishButton()
  }
}

document.getElementById('fab-publish').addEventListener('click', publish)
document.getElementById('btn-publish').addEventListener('click', publish)

function renderResults (data) {
  const el = document.getElementById('publish-results')
  el.hidden = false

  const skipped = Array.isArray(data.skipped) ? data.skipped : []
  el.innerHTML = `
    <div class="results__header">
      <div class="results__title">Resultado del envío</div>
      <div class="results__stats">
        <span class="results__stat--ok">✓ ${data.sent} OK</span>
        <span class="results__stat--fail">✗ ${data.failed} fallidos</span>
      </div>
    </div>
    ${skipped.length > 0 ? `
      <div class="results__dedupe">
        <div class="results__dedupe-title">⇄ ${skipped.length} destino${skipped.length !== 1 ? 's' : ''} omitido${skipped.length !== 1 ? 's' : ''} — otra cuenta ya lo envía</div>
        ${skipped.map(s => `
          <div class="result-row">
            <div style="min-width:0; flex:1;">
              <div>${escapeHtml(findName(s.jid) || s.jid)}</div>
              <div class="result-row__jid">${escapeHtml(s.jid)}</div>
            </div>
            <div class="result-row__status result-row__status--partial">ya lo envía ${escapeHtml(accountLabel(s.kept_by ?? s.keptByAccountId))}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
    <div>
      ${(data.batches || []).map(b => batchResultHtml(b)).join('')}
    </div>
  `
}

function batchResultHtml (b) {
  const accountId = b.accountId ?? b.account_id
  return `
    <div class="batch-result">
      <div class="batch-result__account">
        ${escapeHtml(accountLabel(accountId))}
        <span class="results__stats">
          <span class="results__stat--ok">✓ ${b.sent}</span>
          <span class="results__stat--fail">✗ ${b.failed}</span>
        </span>
      </div>
      ${(b.results || []).map(r => `
        <div class="result-row">
          <div style="min-width:0; flex:1;">
            <div>${escapeHtml(findName(r.jid) || r.jid)}</div>
            <div class="result-row__jid">${escapeHtml(r.jid)}</div>
          </div>
          <div class="result-row__status result-row__status--${r.success ? 'ok' : 'fail'}">
            ${r.success ? '✓ Enviado' : '✗ ' + escapeHtml(r.error || 'Error')}
          </div>
        </div>
      `).join('')}
    </div>
  `
}

/* ---------- Plantillas ---------- */

async function loadTemplates () {
  const listEl = document.getElementById('templates-list')
  try {
    const data = await api('/templates')
    state.templates = data.items || []
    const countEl = document.getElementById('tab-templates-count')
    if (countEl) countEl.textContent = String(state.templates.length)

    // Opciones del selector del editor
    const sel = document.getElementById('publish-template-select')
    const prev = sel.value
    sel.innerHTML = '<option value="">Cargar plantilla…</option>' + state.templates.map(t => {
      const icon = t.media ? (MEDIA_META[t.media.media_type]?.icon || '📎') : ''
      return `<option value="${t.id}">${escapeHtml(t.name)}${icon ? ' ' + icon : ''}</option>`
    }).join('')
    sel.value = state.templates.some(t => String(t.id) === prev) ? prev : ''

    if (state.templates.length === 0) {
      listEl.innerHTML = '<div class="empty">Sin plantillas guardadas. Escribí un mensaje en Publicar y guardalo con un nombre.</div>'
      return
    }
    listEl.innerHTML = state.templates.map(t => `
      <div class="template-row">
        <div class="template-row__info">
          <div class="template-row__name">${escapeHtml(t.name)}</div>
          <div class="template-row__text">${escapeHtml((t.text || '(sin texto — sólo multimedia)').slice(0, 140))}${t.text && t.text.length > 140 ? '…' : ''}</div>
          <div class="template-row__meta">
            ${t.media ? mediaBadgeHtml(t.media) : ''}
            ${t.decorations && t.decorations.forwarded ? '<span class="dec-badge">🔄 Reenviado</span>' : ''}
            <span class="field__hint">actualizada ${formatTimestamp(t.updated_at)}</span>
          </div>
        </div>
        <div class="template-row__actions">
          <button class="btn btn--ghost btn--sm" data-act="load" data-id="${t.id}">Cargar</button>
          <button class="btn btn--ghost btn--sm" data-act="sched" data-id="${t.id}">Programar</button>
          <button class="btn btn--ghost btn--sm" data-act="dup" data-id="${t.id}">Duplicar</button>
          <button class="btn btn--ghost btn--sm btn--danger" data-act="del" data-id="${t.id}">Eliminar</button>
        </div>
      </div>
    `).join('')

    listEl.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleTemplateAction(btn.dataset.act, Number(btn.dataset.id)))
    })
  } catch (err) {
    listEl.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`
  }
}

async function handleTemplateAction (act, id) {
  const t = state.templates.find(x => x.id === id)
  if (!t) return

  if (act === 'load') {
    loadTemplateIntoEditor(t)
    switchPubSubtab('publish')
    toast('Plantilla cargada. Elegí los destinos y publicá.', 'success')
  } else if (act === 'sched') {
    // Cargar el contenido de la plantilla en el formulario unificado y
    // cambiar a modo "programar" para que el usuario defina repetición y horarios.
    loadTemplateIntoEditor(t)
    switchPubSubtab('publish')
    switchSendMode('schedule')
    toast('Plantilla cargada. Definí la repetición y los horarios abajo.', 'success')
  } else if (act === 'dup') {
    try {
      await api('/templates', {
        method: 'POST',
        body: JSON.stringify({
          name: t.name + ' (copia)',
          text: t.text,
          decorations: t.decorations || undefined,
          media_id: t.media ? t.media.id : undefined
        })
      })
      loadTemplates()
      toast('Plantilla duplicada ✓', 'success')
    } catch (err) {
      toast('Error: ' + err.message, 'error')
    }
  } else if (act === 'del') {
    if (!confirmDialog(`¿Eliminar la plantilla "${t.name}"?`)) return
    try {
      await api(`/templates/${id}`, { method: 'DELETE' })
      loadTemplates()
      toast('Plantilla eliminada.', 'success')
    } catch (err) {
      toast('Error: ' + err.message, 'error')
    }
  }
}

async function onPublishTemplateSelected (e) {
  const id = Number(e.target.value)
  if (!id) return
  const t = state.templates.find(x => x.id === id)
  if (!t) return
  loadTemplateIntoEditor(t)
  toast('Plantilla cargada. Elegí los destinos y publicá.', 'success')
}

function loadTemplateIntoEditor (t) {
  document.getElementById('publish-text').value = t.text || ''
  document.getElementById('publish-text').dispatchEvent(new Event('input'))
  document.getElementById('dec-forwarded').checked = !!(t.decorations && t.decorations.forwarded)
  state.publishMedia = t.media || null
  state.mediaFile = null
  if (t.media) {
    renderServerPreview()
  } else {
    clearMedia()
  }
  updatePublishButton()
}

async function saveTemplate () {
  const name = document.getElementById('template-name').value.trim()
  const text = document.getElementById('publish-text').value.trim()
  if (!name) { toast('Poné un nombre a la plantilla.', 'error'); return }
  if (!text && !state.publishMedia) { toast('Escribí el mensaje o adjuntá multimedia antes de guardarlo.', 'error'); return }

  const decorations = {}
  if (document.getElementById('dec-forwarded').checked) decorations.forwarded = true

  try {
    await api('/templates', {
      method: 'POST',
      body: JSON.stringify({
        name,
        text,
        decorations: Object.keys(decorations).length > 0 ? decorations : undefined,
        media_id: state.publishMedia ? state.publishMedia.id : undefined
      })
    })
    document.getElementById('template-name').value = ''
    toast('Plantilla guardada ✓', 'success')
    loadTemplates()
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  }
}

document.getElementById('btn-save-template').addEventListener('click', saveTemplate)
document.getElementById('publish-template-select').addEventListener('change', onPublishTemplateSelected)

/* ---------- Programadas: lista ---------- */

async function loadSchedules () {
  const listEl = document.getElementById('schedules-list')
  try {
    const data = await api('/schedules')
    state.schedules = data.items || []
    const countEl = document.getElementById('tab-schedules-count')
    if (countEl) countEl.textContent = String(state.schedules.filter(s => s.status === 'active').length)

    if (state.schedules.length === 0) {
      listEl.innerHTML = '<div class="empty">Sin programaciones. Creá la primera con el botón "+ Nueva".</div>'
      return
    }
    listEl.innerHTML = state.schedules.map(s => {
      const statusBadgeHtml = s.status === 'active'
        ? '<span class="badge badge--ok">activa</span>'
        : s.status === 'paused'
          ? '<span class="badge badge--warn">pausada</span>'
          : '<span class="badge badge--muted">terminada</span>'
      const actions = []
      if (s.status === 'active') {
        actions.push(`<button class="btn btn--ghost btn--sm" data-act="run" data-id="${s.id}">Ejecutar ahora</button>`)
        actions.push(`<button class="btn btn--ghost btn--sm" data-act="pause" data-id="${s.id}">Pausar</button>`)
      } else if (s.status === 'paused') {
        actions.push(`<button class="btn btn--ghost btn--sm" data-act="resume" data-id="${s.id}">Reanudar</button>`)
      }
      actions.push(`<button class="btn btn--ghost btn--sm" data-act="edit" data-id="${s.id}">Editar</button>`)
      actions.push(`<button class="btn btn--ghost btn--sm btn--danger" data-act="del" data-id="${s.id}">Eliminar</button>`)

      return `
        <div class="schedule-row">
          <div class="schedule-row__info">
            <div class="schedule-row__name">${escapeHtml(s.name)} ${statusBadgeHtml}</div>
            <div class="schedule-row__meta">
              <span class="field__hint">${escapeHtml(scheduleLabel(s))}</span>
              <span class="field__hint">próxima: ${s.next_run_at ? formatTimestamp(s.next_run_at) : '—'}</span>
              <span class="field__hint">última: ${formatTimestamp(s.last_run_at)}</span>
            </div>
            <div class="schedule-row__msgs">
              ${(s.messages || []).map(m => {
                const icon = m.media ? (MEDIA_META[m.media.media_type]?.icon || '📎') : ''
                return `<span class="dec-badge">${icon}${escapeHtml(accountLabel(m.account_id))} → ${m.target_jids.length} destino${m.target_jids.length !== 1 ? 's' : ''}</span>`
              }).join('')}
            </div>
          </div>
          <div class="schedule-row__actions">${actions.join('')}</div>
        </div>
      `
    }).join('')

    listEl.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleScheduleAction(btn.dataset.act, Number(btn.dataset.id)))
    })
  } catch (err) {
    listEl.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`
  }
}

async function handleScheduleAction (act, id) {
  try {
    if (act === 'run') {
      const data = await api(`/schedules/${id}/run`, { method: 'POST' })
      toast(`Ejecutada: ${data.sent} OK / ${data.failed} fallidos.`, data.failed === 0 ? 'success' : 'error')
      loadSchedules()
    } else if (act === 'pause') {
      await api(`/schedules/${id}/pause`, { method: 'POST' })
      loadSchedules()
    } else if (act === 'resume') {
      await api(`/schedules/${id}/resume`, { method: 'POST' })
      loadSchedules()
    } else if (act === 'edit') {
      // Edición se hace dentro del formulario unificado (modo "programar").
      loadScheduleIntoForm(id)
    } else if (act === 'del') {
      const s = state.schedules.find(x => x.id === id)
      if (!confirmDialog(`¿Eliminar la programación "${s ? s.name : id}"?`)) return
      await api(`/schedules/${id}`, { method: 'DELETE' })
      loadSchedules()
      toast('Programación eliminada.', 'success')
      // Si se estaba editando esa programación, limpiar el formulario.
      if (state.editingScheduleId === id) {
        resetUnifiedForm()
        switchSendMode('now')
      }
    }
  } catch (err) {
    if (err.message !== 'Sesión expirada') {
      toast('Error: ' + err.message, 'error')
    }
  }
}

/* ---------- Modo de envío unificado (ahora / programar) ---------- */

function switchSendMode (mode) {
  state.sendMode = mode
  document.querySelectorAll('#send-mode-toggle .send-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode)
  })
  document.getElementById('send-mode-now').hidden = mode !== 'now'
  document.getElementById('send-mode-schedule').hidden = mode !== 'schedule'
  // El FAB sólo tiene sentido en modo "ahora"
  const showFab = state.activeView === 'publish' && state.activePubSubtab === 'publish' && mode === 'now'
  document.getElementById('fab-publish').style.display = showFab ? '' : 'none'
  updatePublishButton()
}

function updateSimpleSchedFields () {
  const type = document.getElementById('sched-type-simple').value
  document.getElementById('simple-once-fields').hidden = type !== 'once'
  document.getElementById('simple-daily-fields').hidden = type !== 'daily'
  document.getElementById('simple-interval-fields').hidden = type !== 'interval'
}

function renderSchedTimeChipsSimple () {
  const box = document.getElementById('sched-times-simple')
  if (!box) return
  if (state.schedTimesSimple.length === 0) {
    box.innerHTML = '<span class="field__hint">Sin horarios todavía — agregá al menos uno.</span>'
    return
  }
  box.innerHTML = state.schedTimesSimple.map((t, i) => `
    <span class="time-chip">
      ${minutesToHHMM(t)}
      <button type="button" data-remove-time="${i}" title="Quitar horario">×</button>
    </span>
  `).join('')
  box.querySelectorAll('[data-remove-time]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.schedTimesSimple.splice(Number(btn.dataset.removeTime), 1)
      renderSchedTimeChipsSimple()
    })
  })
}

function addSchedTimeSimple () {
  const mins = hhmmToMinutes(document.getElementById('sched-new-time-simple').value)
  if (mins === null) { toast('Elegí una hora válida.', 'error'); return }
  if (state.schedTimesSimple.includes(mins)) { toast('Ese horario ya está agregado.', 'error'); return }
  if (state.schedTimesSimple.length >= 20) { toast('Máximo 20 horarios por día.', 'error'); return }
  state.schedTimesSimple.push(mins)
  state.schedTimesSimple.sort((a, b) => a - b)
  renderSchedTimeChipsSimple()
}

/**
 * Carga una programación existente en el formulario unificado para editarla.
 * - El primer mensaje aporta texto, multimedia y decoraciones.
 * - Los destinos de TODOS los mensajes se suman a state.selectedJids para
 *   que la lista de Destinos muestre lo que ya estaba elegido.
 * - Los horarios/tipo/fecha se cargan en los campos simplificados.
 * - Si la programación usaba tipos no soportados en el formulario simple
 *   (weekly/monthly), se avisa y se degrada a 'daily'.
 */
function loadScheduleIntoForm (scheduleId) {
  const s = state.schedules.find(x => x.id === scheduleId)
  if (!s) { toast('No se encontró la programación.', 'error'); return }

  state.editingScheduleId = scheduleId
  // Asegurarse de estar en el sub-tab correcto y en modo "programar"
  if (state.activePubSubtab !== 'publish') switchPubSubtab('publish')
  switchSendMode('schedule')

  // Nombre
  document.getElementById('sched-name-simple').value = s.name || ''

  // Tipo: el formulario simple soporta once/daily/interval. weekly/monthly
  // se degradan a daily con aviso (mejor que romper silenciosamente).
  let type = s.sched_type
  if (type !== 'once' && type !== 'daily' && type !== 'interval') {
    toast('Esta programación usaba repetición "' + type + '". Se carga como "diaria" — guardá para confirmar el cambio.', 'error')
    type = 'daily'
  }
  document.getElementById('sched-type-simple').value = type

  // Campos según tipo
  if (type === 'once' && s.scheduled_at) {
    const d = new Date(s.scheduled_at - new Date().getTimezoneOffset() * 60000)
    document.getElementById('sched-datetime-simple').value = d.toISOString().slice(0, 16)
  } else {
    document.getElementById('sched-datetime-simple').value = ''
  }

  state.schedTimesSimple = Array.isArray(s.recur_times) && s.recur_times.length > 0
    ? [...s.recur_times]
    : (s.recur_time !== null && s.recur_time !== undefined ? [s.recur_time] : [])
  if (type === 'daily' && state.schedTimesSimple.length === 0) {
    state.schedTimesSimple = [9 * 60] // valor por defecto sensato
  }
  renderSchedTimeChipsSimple()

  if (type === 'interval' && s.interval_minutes) {
    document.getElementById('sched-interval-simple').value = String(s.interval_minutes)
  } else {
    document.getElementById('sched-interval-simple').value = '90'
  }
  updateSimpleSchedFields()

  // Mensaje: el primero aporta el texto/media/decoraciones al formulario.
  const firstMsg = (s.messages || [])[0]
  if (firstMsg) {
    document.getElementById('publish-text').value = firstMsg.text || ''
    document.getElementById('publish-text').dispatchEvent(new Event('input'))
    document.getElementById('dec-forwarded').checked = !!(firstMsg.decorations && firstMsg.decorations.forwarded)
    state.publishMedia = firstMsg.media || null
    state.mediaFile = null
    if (firstMsg.media) {
      renderServerPreview()
    } else {
      clearMedia()
    }
  }

  // Destinos: todos los (account_id, target_jids) de los mensajes se suman
  // a state.selectedJids para que la lista de Destinos muestre los elegidos.
  state.selectedJids = {}
  state.dupeChoice = {}
  for (const m of (s.messages || [])) {
    if (!state.selectedJids[m.account_id]) state.selectedJids[m.account_id] = new Set()
    for (const jid of (m.target_jids || [])) state.selectedJids[m.account_id].add(jid)
  }
  // assign_map del schedule -> dupeChoice (mismísimo formato)
  if (s.assign_map && typeof s.assign_map === 'object') {
    state.dupeChoice = { ...s.assign_map }
  }

  // Cambiar a la cuenta del primer mensaje (si existe) para que la lista de
  // destinos muestre los grupos de esa cuenta.
  if (firstMsg && firstMsg.account_id) {
    state.activeAccountId = firstMsg.account_id
    renderAccountChips()
    // Asegurar que los grupos de cada cuenta usada estén cargados.
    for (const accId of Object.keys(state.selectedJids)) {
      loadGroupsForAccount(Number(accId))
    }
  }
  renderTargets()
  updatePublishButton()

  // Scroll al formulario y aviso claro de que está editando.
  document.getElementById('send-mode-schedule').scrollIntoView({ behavior: 'smooth', block: 'start' })
  toast(`Editando "${s.name}". Modificá lo que haga falta y presioná "Crear programación" para guardar los cambios.`, 'success')
}

/**
 * Resetea el formulario a su estado inicial (usado después de crear/guardar).
 * NO borra las programaciones existentes, sólo el formulario.
 */
function resetUnifiedForm () {
  state.editingScheduleId = null
  state.schedTimesSimple = []
  state.selectedJids = {}
  state.dupeChoice = {}
  document.getElementById('publish-text').value = ''
  document.getElementById('publish-text').dispatchEvent(new Event('input'))
  document.getElementById('dec-forwarded').checked = false
  document.getElementById('sched-name-simple').value = ''
  document.getElementById('sched-type-simple').value = 'once'
  document.getElementById('sched-datetime-simple').value = ''
  document.getElementById('sched-interval-simple').value = '90'
  clearMedia()
  renderSchedTimeChipsSimple()
  updateSimpleSchedFields()
  renderTargets()
  updatePublishButton()
}

/**
 * Construye los items[] (uno por cuenta con destinos) a partir del estado
 * actual del formulario unificado. Es el mismo building block que usa el
 * publish inmediato — sólo varía el envío (programado vs. ahora).
 */
function buildItemsFromSelection () {
  const text = document.getElementById('publish-text').value.trim()
  const decorations = {}
  if (document.getElementById('dec-forwarded').checked) decorations.forwarded = true

  const items = []
  for (const acc of state.accounts) {
    const set = state.selectedJids[acc.id]
    if (set && set.size > 0) {
      items.push({
        account_id: acc.id,
        text,
        target_jids: Array.from(set),
        decorations: Object.keys(decorations).length > 0 ? { ...decorations } : undefined,
        media_id: state.publishMedia ? state.publishMedia.id : undefined
      })
    }
  }
  return items
}

/**
 * Construye el assign_map para destinos duplicados entre cuentas —
 * mismo formato que ya usa publish().
 */
function buildAssignMap () {
  const accountsByJid = new Map()
  for (const acc of state.accounts) {
    const set = state.selectedJids[acc.id]
    if (!set) continue
    for (const jid of set) {
      if (!accountsByJid.has(jid)) accountsByJid.set(jid, [])
      accountsByJid.get(jid).push(acc.id)
    }
  }
  const assign = {}
  for (const [jid, accIds] of accountsByJid) {
    if (accIds.length < 2) continue
    const chosen = state.dupeChoice[jid]
    assign[jid] = accIds.includes(chosen) ? chosen : accIds[0]
  }
  return Object.keys(assign).length > 0 ? assign : undefined
}

/**
 * Recopila y valida los datos del formulario unificado en modo "programar".
 * Devuelve el payload listo para POST/PUT a /api/schedules, o null si falla.
 */
function collectSimpleScheduleData () {
  const name = document.getElementById('sched-name-simple').value.trim()
  const type = document.getElementById('sched-type-simple').value

  // Items compartidos con el modo "ahora"
  const items = buildItemsFromSelection()
  if (items.length === 0) { toast('Elegí al menos un destino.', 'error'); return null }

  const text = document.getElementById('publish-text').value.trim()
  const hasMedia = !!state.publishMedia
  if (!text && !hasMedia) { toast('Debe haber al menos texto o un archivo multimedia.', 'error'); return null }

  // Validación específica del tipo de repetición
  let scheduled_at = null
  let recur_time = null
  let recur_times = null
  let interval_minutes = null

  if (type === 'once') {
    const dtv = document.getElementById('sched-datetime-simple').value
    if (!dtv) { toast('Elegí fecha y hora.', 'error'); return null }
    scheduled_at = new Date(dtv).getTime()
    if (scheduled_at < Date.now() - 60000) {
      // Tolerancia de 1 min para no marear con desfases de reloj.
      toast('La fecha y hora ya pasaron. Elegí un momento futuro.', 'error')
      return null
    }
  } else if (type === 'daily') {
    if (state.schedTimesSimple.length === 0) { toast('Agregá al menos un horario del día.', 'error'); return null }
    recur_times = state.schedTimesSimple
    recur_time = state.schedTimesSimple[0]
  } else if (type === 'interval') {
    const iv = Number(document.getElementById('sched-interval-simple').value)
    if (!Number.isInteger(iv) || iv < 1 || iv > 1440) {
      toast('El intervalo debe estar entre 1 y 1440 minutos.', 'error')
      return null
    }
    interval_minutes = iv
  }

  // Nombre autogenerado si está vacío
  const finalName = name || (() => {
    const d = new Date()
    const pad = n => String(n).padStart(2, '0')
    const stamp = `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    const typeLabel = type === 'once' ? 'una vez' : (type === 'daily' ? 'diaria' : `cada ${interval_minutes}m`)
    return `Programación ${typeLabel} (${stamp})`
  })()

  // messages[] respeta el formato del backend:
  // { account_id, target_jids, text, decorations, media_id }
  const messages = items.map(it => ({
    account_id: it.account_id,
    target_jids: it.target_jids,
    text: it.text,
    decorations: it.decorations,
    media_id: it.media_id
  }))

  return {
    name: finalName,
    sched_type: type,
    scheduled_at,
    recur_time,
    recur_times,
    recur_dow: null,
    recur_dom: null,
    interval_minutes,
    window_start: null,
    window_end: null,
    tz_offset_min: new Date().getTimezoneOffset(),
    messages,
    assign_map: buildAssignMap()
  }
}

async function createSchedule () {
  if (state.uploading) { toast('Esperá a que termine de subir la multimedia.', 'error'); return }
  const data = collectSimpleScheduleData()
  if (!data) return

  const btn = document.getElementById('btn-schedule-simple')
  const btnText = btn.querySelector('.btn__text')
  const btnSpinner = btn.querySelector('.btn__spinner')
  btn.disabled = true
  btnText.textContent = state.editingScheduleId ? 'Guardando…' : 'Creando…'
  btnSpinner.hidden = false

  try {
    if (state.editingScheduleId) {
      await api(`/schedules/${state.editingScheduleId}`, {
        method: 'PUT',
        body: JSON.stringify(data)
      })
      toast('Programación actualizada ✓', 'success')
    } else {
      await api('/schedules', {
        method: 'POST',
        body: JSON.stringify(data)
      })
      toast('Programación creada ✓', 'success')
    }
    resetUnifiedForm()
    switchSendMode('now') // volver al modo "ahora" después de crear/editar
    loadSchedules()
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  } finally {
    btn.disabled = false
    btnText.textContent = 'Crear programación'
    btnSpinner.hidden = true
    updatePublishButton()
  }
}


/* ---------- Historial ---------- */

async function loadHistory () {
  const listEl = document.getElementById('history-list')
  listEl.innerHTML = '<div class="empty">Cargando historial…</div>'
  try {
    const data = await api('/publish/history')
    if (data.count === 0) {
      listEl.innerHTML = '<div class="empty">Sin publicaciones todavía.</div>'
      return
    }
    listEl.innerHTML = data.items.map(item => {
      const statusClass = item.status === 'sent' ? 'ok' : (item.status === 'partial' ? 'partial' : 'fail')
      const statusLabel = item.status === 'sent' ? '✓ Enviado' : (item.status === 'partial' ? '⚠ Parcial' : '✗ Falló')
      const decorations = item.decorations || {}
      const decBadges = []
      if (decorations.forwarded) decBadges.push('🔄 Reenviado')
      if (item.schedule_id) decBadges.push('⏰ Programada')
      if (item.content_type && item.content_type !== 'text') {
        const meta = MEDIA_META[item.content_type]
        decBadges.push((meta ? meta.icon : '📎') + ' ' + (meta ? meta.label : item.content_type))
      }
      if (item.account_id) decBadges.push(escapeHtml(accountLabel(item.account_id)))

      return `
        <div class="history-batch" data-batch-id="${item.id}">
          <div class="history-batch__header" data-toggle="${item.id}">
            <div class="history-batch__info">
              <div class="history-batch__text">${escapeHtml((item.text || '(sin texto)').slice(0, 100))}${item.text && item.text.length > 100 ? '…' : ''}</div>
              <div class="history-batch__meta">
                <span class="history-batch__date">${escapeHtml(formatTimestamp(item.sent_at))}</span>
                <span class="history-batch__stats">${item.sent_count}/${item.total_targets} enviados</span>
                ${decBadges.length ? `<span class="history-batch__dec">${decBadges.map(b => `<span class="dec-badge">${b}</span>`).join('')}</span>` : ''}
              </div>
            </div>
            <div class="result-row__status result-row__status--${statusClass}">${statusLabel}</div>
            <span class="history-batch__toggle">▾</span>
          </div>
          <div class="history-batch__details" id="batch-details-${item.id}" hidden>
            <div class="empty">Cargando destinos…</div>
          </div>
        </div>
      `
    }).join('')

    listEl.querySelectorAll('.history-batch__header[data-toggle]').forEach(h => {
      h.addEventListener('click', () => toggleBatchDetails(Number(h.dataset.toggle)))
    })
  } catch (err) {
    listEl.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`
  }
}

async function toggleBatchDetails (batchId) {
  const detailsEl = document.getElementById(`batch-details-${batchId}`)
  if (!detailsEl) return

  if (!detailsEl.hidden) {
    detailsEl.hidden = true
    return
  }

  detailsEl.hidden = false
  detailsEl.innerHTML = '<div class="empty">Cargando destinos…</div>'

  try {
    const data = await api(`/publish/history/${batchId}`)
    detailsEl.innerHTML = data.items.map(item => {
      const name = findName(item.target_jid)
      const isChannel = item.target_jid.endsWith('@newsletter')
      const icon = isChannel ? '📢' : '👥'
      return `
        <div class="result-row">
          <div style="min-width:0; flex:1;">
            <div>${icon} ${escapeHtml(name || item.target_jid)}</div>
            <div class="result-row__jid">${escapeHtml(item.target_jid)}</div>
          </div>
          <div class="result-row__status result-row__status--${item.status === 'sent' ? 'ok' : 'fail'}">
            ${item.status === 'sent' ? '✓ Enviado' : '✗ ' + escapeHtml(item.error || 'Error')}
          </div>
        </div>
      `
    }).join('')
  } catch (err) {
    detailsEl.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`
  }
}

/* ---------- Cuentas: lista y acciones ---------- */

async function renderAccountsList () {
  const listEl = document.getElementById('accounts-list')
  // Refresco silencioso para tener has_session y contadores al día
  try {
    const data = await api('/accounts')
    state.accounts = data.accounts || []
    updateBotStatus()
    updateAccountsCount()
    renderAccountChips()
  } catch { /* usamos lo que haya en memoria */ }

  if (state.accounts.length === 0) {
    listEl.innerHTML = '<div class="empty">Sin cuentas. Agregá la primera arriba.</div>'
    return
  }

  listEl.innerHTML = state.accounts.map(acc => {
    const isSelf = state.linkingAccountId === acc.id
    const actions = []
    if (isSelf) {
      actions.push(`<span class="badge badge--warn">vinculando…</span>`)
    } else if (!acc.has_session) {
      actions.push(`<button class="btn btn--ghost btn--sm" data-act="link" data-id="${acc.id}">Vincular</button>`)
    } else if (acc.status !== 'connected') {
      actions.push(`<button class="btn btn--ghost btn--sm" data-act="reconnect" data-id="${acc.id}">Reconectar</button>`)
    }
    if (acc.status === 'connected') {
      actions.push(`<button class="btn btn--ghost btn--sm" data-act="sync" data-id="${acc.id}">Sincronizar</button>`)
    }
    if (acc.has_session) {
      actions.push(`<button class="btn btn--ghost btn--sm" data-act="unlink" data-id="${acc.id}">Desvincular</button>`)
    }
    actions.push(`<button class="btn btn--ghost btn--sm btn--danger" data-act="delete" data-id="${acc.id}">Eliminar</button>`)

    return `
      <div class="account-row">
        <div class="account-row__info">
          <div class="account-row__label">${escapeHtml(acc.label)}</div>
          <div class="account-row__meta">
            ${statusBadge(acc.status)}
            <span class="field__hint">${escapeHtml(acc.phone || 'sin número')}</span>
            <span class="field__hint">${acc.admin_groups} grupos admin</span>
            <span class="field__hint">últ. conexión: ${formatTimestamp(acc.last_connected_at)}</span>
          </div>
        </div>
        <div class="account-row__actions">${actions.join('')}</div>
      </div>
    `
  }).join('')

  listEl.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => handleAccountAction(btn.dataset.act, Number(btn.dataset.id)))
  })
}

async function handleAccountAction (act, accountId) {
  try {
    if (act === 'link') {
      await startLinking(accountId, 'qr')
    } else if (act === 'reconnect') {
      await api(`/accounts/${accountId}/reconnect`, { method: 'POST' })
      toast('Reconectando…', 'success')
    } else if (act === 'sync') {
      const data = await api(`/accounts/${accountId}/sync`, { method: 'POST' })
      await loadGroupsForAccount(accountId)
      toast(`Sincronizado: ${data.admin_groups} grupos y ${data.admin_newsletters} canales admin.`, 'success')
    } else if (act === 'unlink') {
      if (!confirmDialog('¿Desvincular la cuenta? Tendrás que escanear el QR otra vez para usarla.')) return
      await api(`/accounts/${accountId}/unlink`, { method: 'POST' })
      toast('Cuenta desvinculada.', 'success')
      await loadAccounts(true)
      renderAccountsList()
    } else if (act === 'delete') {
      if (!confirmDialog('¿Eliminar la cuenta? Se borra su sesión, su caché de grupos y sus mensajes programados.')) return
      await api(`/accounts/${accountId}`, { method: 'DELETE' })
      toast('Cuenta eliminada.', 'success')
      await loadAccounts(true)
      renderAccountsList()
    }
  } catch (err) {
    if (err.message !== 'Sesión expirada') {
      toast('Error: ' + err.message, 'error')
    }
  }
}

async function addAccount () {
  const label = document.getElementById('new-account-label').value.trim()
  const phone = document.getElementById('new-account-phone').value.trim()
  if (!label) { toast('Poné un nombre para identificar la cuenta.', 'error'); return }
  if (!phone) { toast('Poné el número de teléfono.', 'error'); return }

  try {
    const data = await api('/accounts', {
      method: 'POST',
      body: JSON.stringify({ label, phone })
    })
    document.getElementById('new-account-label').value = ''
    document.getElementById('new-account-phone').value = ''
    await loadAccounts(true)
    renderAccountsList()
    toast(`Cuenta "${label}" creada. Vinculá ahora.`, 'success')
    await startLinking(data.id, 'qr')
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  }
}

/* ---------- Vinculación (QR + código) ---------- */

async function startLinking (accountId, method) {
  const card = document.getElementById('linking-card')
  const acc = state.accounts.find(a => a.id === accountId)
  document.getElementById('linking-title').textContent = `Vinculando: ${acc ? acc.label : accountId} (${acc ? acc.phone : ''})`
  document.getElementById('qr-img').hidden = true
  document.getElementById('qr-img').src = ''
  document.getElementById('qr-status').hidden = false
  document.getElementById('qr-status').textContent = 'Esperando QR…'
  document.getElementById('pairing-code').hidden = true
  card.hidden = false
  card.scrollIntoView({ behavior: 'smooth' })

  try {
    await api(`/accounts/${accountId}/link`, {
      method: 'POST',
      body: JSON.stringify({ method })
    })
  } catch (err) {
    toast('Error: ' + err.message, 'error')
    card.hidden = true
    return
  }

  state.linkingAccountId = accountId
  startLinkPolling()
}

function startLinkPolling () {
  stopLinkPolling()
  state.linkPollTimer = setInterval(async () => {
    const accountId = state.linkingAccountId
    if (!accountId) { stopLinkPolling(); return }
    try {
      const data = await api(`/accounts/${accountId}/pairing`)
      if (data.status === 'connected') {
        stopLinkPolling()
        document.getElementById('linking-card').hidden = true
        state.linkingAccountId = null
        toast('¡Cuenta conectada! Sincronizando grupos…', 'success')
        await loadAccounts(true)
        renderAccountsList()
        renderTargets()
        return
      }
      if (data.qr) {
        const img = document.getElementById('qr-img')
        if (img.getAttribute('src') !== data.qr) {
          img.src = data.qr
          img.hidden = false
          document.getElementById('qr-status').hidden = true
        }
      }
      if (data.pairing_code) {
        const pc = document.getElementById('pairing-code')
        pc.textContent = 'Código: ' + data.pairing_code.slice(0, 4) + '-' + data.pairing_code.slice(4)
        pc.hidden = false
      }
      if (data.status === 'pending' || data.status === 'disconnected') {
        const st = document.getElementById('qr-status')
        st.hidden = false
        st.textContent = 'Vinculación cancelada o caída. Volvé a intentar.'
      }
    } catch { /* seguimos pollenando */ }
  }, 3000)
}

function stopLinkPolling () {
  if (state.linkPollTimer) {
    clearInterval(state.linkPollTimer)
    state.linkPollTimer = null
  }
}

async function requestPairingCode () {
  const accountId = state.linkingAccountId
  if (!accountId) return
  try {
    const data = await api(`/accounts/${accountId}/pairing-code`, { method: 'POST' })
    const pc = document.getElementById('pairing-code')
    pc.textContent = 'Código: ' + data.code
    pc.hidden = false
  } catch (err) {
    toast('Error pidiendo código: ' + err.message, 'error')
  }
}

async function cancelLinking () {
  const accountId = state.linkingAccountId
  if (!accountId) return
  stopLinkPolling()
  try {
    await api(`/accounts/${accountId}/cancel`, { method: 'POST' })
  } catch { /* igual cerramos */ }
  state.linkingAccountId = null
  document.getElementById('linking-card').hidden = true
  await loadAccounts(true)
  renderAccountsList()
}

/* ---------- Usuarios (superadmin) ---------- */

async function loadAdmins () {
  const listEl = document.getElementById('admins-list')
  if (state.admin?.role !== 'superadmin') {
    listEl.innerHTML = '<div class="empty">Sólo el superadmin ve esta sección.</div>'
    return
  }
  try {
    const data = await api('/admins')
    if (data.count === 0) {
      listEl.innerHTML = '<div class="empty">Sin administradores.</div>'
      return
    }
    listEl.innerHTML = data.items.map(a => {
      const isSelf = a.id === state.admin.id
      const roleBadge = a.role === 'superadmin'
        ? '<span class="badge badge--info">superadmin</span>'
        : '<span class="badge badge--muted">admin</span>'
      const stateBadge = a.disabled
        ? '<span class="badge badge--danger">deshabilitado</span>'
        : '<span class="badge badge--ok">activo</span>'
      const actions = []
      if (!isSelf) {
        actions.push(`<button class="btn btn--ghost btn--sm" data-act="pass" data-id="${a.id}">Reset contraseña</button>`)
        if (a.disabled) {
          actions.push(`<button class="btn btn--ghost btn--sm" data-act="enable" data-id="${a.id}">Habilitar</button>`)
        } else {
          actions.push(`<button class="btn btn--ghost btn--sm" data-act="disable" data-id="${a.id}">Deshabilitar</button>`)
        }
        actions.push(`<button class="btn btn--ghost btn--sm btn--danger" data-act="del" data-id="${a.id}">Eliminar</button>`)
      } else {
        actions.push('<span class="field__hint">vos</span>')
      }
      return `
        <div class="account-row">
          <div class="account-row__info">
            <div class="account-row__label">${escapeHtml(a.username)} ${roleBadge} ${stateBadge}</div>
            <div class="account-row__meta">
              <span class="field__hint">${a.accounts_count} cuentas (${a.connected_accounts} conectadas)</span>
              <span class="field__hint">${a.admin_groups} grupos admin</span>
              <span class="field__hint">${a.schedules_count} programaciones activas</span>
              <span class="field__hint">creado ${formatTimestamp(a.created_at)}</span>
            </div>
          </div>
          <div class="account-row__actions">${actions.join('')}</div>
        </div>
      `
    }).join('')

    listEl.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleAdminAction(btn.dataset.act, Number(btn.dataset.id)))
    })
  } catch (err) {
    listEl.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`
  }
}

async function handleAdminAction (act, id) {
  try {
    if (act === 'pass') {
      const pass = window.prompt('Nueva contraseña (mínimo 8 caracteres):')
      if (!pass) return
      await api(`/admins/${id}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password: pass })
      })
      toast('Contraseña actualizada (sus sesiones quedaron revocadas).', 'success')
      loadAdmins()
    } else if (act === 'disable') {
      await api(`/admins/${id}/disable`, { method: 'POST' })
      loadAdmins()
    } else if (act === 'enable') {
      await api(`/admins/${id}/enable`, { method: 'POST' })
      loadAdmins()
    } else if (act === 'del') {
      if (!confirmDialog('¿Eliminar este admin? Se borran también sus cuentas, plantillas y programaciones.')) return
      await api(`/admins/${id}`, { method: 'DELETE' })
      toast('Admin eliminado.', 'success')
      loadAdmins()
    }
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  }
}

async function addAdmin () {
  const username = document.getElementById('new-admin-username').value.trim()
  const password = document.getElementById('new-admin-password').value
  const role = document.getElementById('new-admin-role').value
  if (!username || !password) { toast('Completá usuario y contraseña.', 'error'); return }

  try {
    await api('/admins', {
      method: 'POST',
      body: JSON.stringify({ username, password, role })
    })
    document.getElementById('new-admin-username').value = ''
    document.getElementById('new-admin-password').value = ''
    toast(`Admin "${username}" creado ✓`, 'success')
    loadAdmins()
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  }
}

/* ---------- Init ---------- */

async function afterLogin () {
  try {
    await loadAccounts()
  } catch (err) {
    toast('Error cargando cuentas: ' + err.message, 'error')
  }
  renderTargets()
  startStatusPolling()
  // Precargar plantillas para el selector del formulario (silencioso)
  try { await loadTemplates() } catch { /* la vista mostrará el error */ }
  // Cargar la lista de programaciones (siempre visible abajo del formulario).
  try { await loadSchedules() } catch { /* la vista mostrará el error */ }
  // Inicializar el formulario unificado en modo "ahora"
  switchSendMode('now')
  renderSchedTimeChipsSimple()
  updateSimpleSchedFields()
}

document.getElementById('login-form').addEventListener('submit', e => {
  e.preventDefault()
  const username = document.getElementById('login-username').value.trim()
  const password = document.getElementById('login-password').value
  if (!username || !password) return
  doLogin(username, password)
})

document.getElementById('btn-logout').addEventListener('click', doLogout)
document.getElementById('mobile-logout').addEventListener('click', doLogout)
document.getElementById('btn-add-account').addEventListener('click', addAccount)
document.getElementById('btn-cancel-link').addEventListener('click', cancelLinking)
document.getElementById('btn-request-code').addEventListener('click', requestPairingCode)
document.getElementById('btn-add-admin').addEventListener('click', addAdmin)

// Toggle de modo de envío unificado (ahora / programar)
document.querySelectorAll('#send-mode-toggle .send-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => switchSendMode(btn.dataset.mode))
})
// Sub-mode del programador simplificado
document.getElementById('sched-type-simple').addEventListener('change', updateSimpleSchedFields)
document.getElementById('btn-add-time-simple').addEventListener('click', addSchedTimeSimple)
// Botón "Crear programación" en modo programar
document.getElementById('btn-schedule-simple').addEventListener('click', createSchedule)

setupMediaAttach()
checkSession()
