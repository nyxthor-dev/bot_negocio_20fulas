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
  editingScheduleId: null,
  schedMsgSeq: 0,
  schedTimes: [],           // horarios del día del editor (minutos 0-1439)
  schedAssign: {},          // jid -> account_id elegido (editor de programaciones)
  linkingAccountId: null,
  linkPollTimer: null,
  statusPollTimer: null,
  activeView: 'publish',
  activePubSubtab: 'publish',
  activeHistSubtab: 'history'
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

  // El FAB de Publicar sólo corresponde a la vista Publicar
  document.getElementById('fab-publish').style.display = viewName === 'publish' ? '' : 'none'

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
  document.getElementById('subtab-schedules').hidden = subtab !== 'schedules'

  // El FAB y el botón publicar sólo aplican al sub-tab de Publicar
  const showFab = subtab === 'publish'
  document.getElementById('fab-publish').style.display = showFab ? '' : 'none'

  if (subtab === 'templates') loadTemplates()
  if (subtab === 'schedules') loadSchedules()
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

/* ---------- Botón Publicar (FAB móvil + botón desktop) ---------- */

function updatePublishButton () {
  const text = document.getElementById('publish-text').value.trim()
  const hasMedia = !!state.publishMedia || !!state.mediaFile
  const hasContent = text.length > 0 || hasMedia
  const anyTarget = Object.values(state.selectedJids).some(set => set && set.size > 0)
  // Mientras se sube la multimedia no se puede publicar (faltaria el media_id)
  const disabled = state.publishing || state.uploading || !hasContent || !anyTarget
  document.getElementById('fab-publish').disabled = disabled
  document.getElementById('btn-publish').disabled = disabled
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
    switchPubSubtab('schedules')
    openScheduleEditor(null, t)
    toast('Programación iniciada desde la plantilla — elegí repetición, horarios y cuentas.', 'success')
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
      openScheduleEditor(id)
    } else if (act === 'del') {
      const s = state.schedules.find(x => x.id === id)
      if (!confirmDialog(`¿Eliminar la programación "${s ? s.name : id}"?`)) return
      await api(`/schedules/${id}`, { method: 'DELETE' })
      loadSchedules()
      toast('Programación eliminada.', 'success')
    }
  } catch (err) {
    if (err.message !== 'Sesión expirada') {
      toast('Error: ' + err.message, 'error')
    }
  }
}

/* ---------- Editor de programaciones ---------- */

function openScheduleEditor (scheduleId = null, template = null) {
  state.editingScheduleId = scheduleId
  const editor = document.getElementById('schedule-editor')
  document.getElementById('schedule-editor-title').textContent = scheduleId ? 'Editar programación' : 'Nueva programación'
  document.getElementById('sched-messages').innerHTML = ''
  state.schedMsgSeq = 0
  state.schedTimes = []
  state.schedAssign = {} // elección de cuenta para duplicados, se hidrata al editar
  document.getElementById('sched-window-on').checked = false

  if (scheduleId) {
    const s = state.schedules.find(x => x.id === scheduleId)
    if (s) {
      state.schedAssign = (s.assign_map && typeof s.assign_map === 'object') ? { ...s.assign_map } : {}
      document.getElementById('sched-name').value = s.name
      document.getElementById('sched-type').value = s.sched_type
      if (s.sched_type === 'once' && s.scheduled_at) {
        const d = new Date(s.scheduled_at - new Date().getTimezoneOffset() * 60000)
        document.getElementById('sched-datetime').value = d.toISOString().slice(0, 16)
      }
      state.schedTimes = Array.isArray(s.recur_times) && s.recur_times.length > 0
        ? [...s.recur_times]
        : (s.recur_time !== null && s.recur_time !== undefined ? [s.recur_time] : [])
      if (s.sched_type === 'interval' && s.interval_minutes) {
        document.getElementById('sched-interval').value = String(s.interval_minutes)
        if (s.window_start != null && s.window_end != null) {
          document.getElementById('sched-window-on').checked = true
          document.getElementById('sched-window-start').value = minutesToHHMM(s.window_start)
          document.getElementById('sched-window-end').value = minutesToHHMM(s.window_end)
        }
      }
      if (s.recur_dow !== null && s.recur_dow !== undefined) document.getElementById('sched-dow').value = String(s.recur_dow)
      if (s.recur_dom !== null && s.recur_dom !== undefined) document.getElementById('sched-dom').value = String(s.recur_dom)
      ;(s.messages || []).forEach(m => addSchedMessageRow(m))
    }
  } else {
    document.getElementById('sched-name').value = ''
    document.getElementById('sched-type').value = 'daily'
    document.getElementById('sched-datetime').value = ''
    document.getElementById('sched-interval').value = '90'
    state.schedTimes = [9 * 60]
    if (template) {
      document.getElementById('sched-name').value = template.name
      addSchedMessageRow({
        account_id: state.accounts.length > 0 ? state.accounts[0].id : null,
        text: template.text || '',
        target_jids: [],
        decorations: template.decorations || null,
        media: template.media || null
      })
    } else {
      addSchedMessageRow(null)
    }
  }

  renderSchedTimeChips()
  updateSchedTypeFields()
  editor.hidden = false
  editor.scrollIntoView({ behavior: 'smooth' })
}

function updateSchedTypeFields () {
  const type = document.getElementById('sched-type').value
  const isRecur = type === 'daily' || type === 'weekly' || type === 'monthly'
  document.getElementById('sched-once-fields').hidden = type !== 'once'
  document.getElementById('sched-recur-fields').hidden = !isRecur
  document.getElementById('sched-interval-fields').hidden = type !== 'interval'
  document.getElementById('sched-dow-field').hidden = type !== 'weekly'
  document.getElementById('sched-dom-field').hidden = type !== 'monthly'
  document.getElementById('sched-window-fields').hidden = !document.getElementById('sched-window-on').checked
}

/* ---------- Horarios del día (chips) ---------- */

function renderSchedTimeChips () {
  const box = document.getElementById('sched-times-chips')
  if (state.schedTimes.length === 0) {
    box.innerHTML = '<span class="field__hint">Sin horarios todavía — agregá al menos uno.</span>'
    return
  }
  box.innerHTML = state.schedTimes.map((t, i) => `
    <span class="time-chip">
      ${minutesToHHMM(t)}
      <button type="button" data-remove-time="${i}" title="Quitar horario">×</button>
    </span>
  `).join('')
  box.querySelectorAll('[data-remove-time]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.schedTimes.splice(Number(btn.dataset.removeTime), 1)
      renderSchedTimeChips()
    })
  })
}

function addSchedTime () {
  const mins = hhmmToMinutes(document.getElementById('sched-new-time').value)
  if (mins === null) { toast('Elegí una hora válida.', 'error'); return }
  if (state.schedTimes.includes(mins)) { toast('Ese horario ya está agregado.', 'error'); return }
  if (state.schedTimes.length >= 20) { toast('Máximo 20 horarios por día.', 'error'); return }
  state.schedTimes.push(mins)
  state.schedTimes.sort((a, b) => a - b)
  renderSchedTimeChips()
}

/* ---------- Mensajes de la programación ---------- */

/** Re-renderiza las listas de destinos visibles del editor (sincroniza avisos y elección). */
function refreshVisibleSchedTargets () {
  document.querySelectorAll('.sched-msg').forEach(r => {
    const t = r.querySelector('.sched-msg__targets')
    if (!t.hidden && r._renderTargets) r._renderTargets()
  })
}

function addSchedMessageRow (msg) {
  const seq = ++state.schedMsgSeq
  const wrap = document.getElementById('sched-messages')
  const row = document.createElement('div')
  row.className = 'sched-msg'
  row.dataset.seq = String(seq)

  const accountOptions = state.accounts.map(a =>
    `<option value="${a.id}" ${msg && msg.account_id === a.id ? 'selected' : ''}>${escapeHtml(a.label)} (${a.status === 'connected' ? 'conectada' : 'no conectada'})</option>`
  ).join('')

  const tplOptions = ['<option value="">Cargar plantilla…</option>'].concat(
    state.templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
  ).join('')

  row.innerHTML = `
    <div class="sched-msg__header">
      <select class="field__input sched-msg__account">
        ${accountOptions || '<option value="">Sin cuentas</option>'}
      </select>
      <div class="sched-msg__tools">
        <button class="btn btn--ghost btn--sm" data-tool="copy" type="button">Copiar a cuentas…</button>
        <button class="btn btn--ghost btn--sm btn--danger" data-tool="del" type="button">Quitar</button>
      </div>
    </div>
    <div class="sched-msg__tplrow">
      <select class="field__input sched-msg__tpl">${tplOptions}</select>
    </div>
    <div class="attach-row attach-row--sm">
      <input type="file" class="sched-msg__file" accept="image/*,video/*,audio/*,.pdf,.txt,.doc,.docx,.odt,.zip" hidden />
      <button type="button" class="btn btn--ghost btn--sm sched-msg__attachbtn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        <span>Adjuntar</span>
      </button>
      <span class="attach-row__name sched-msg__attachname" hidden></span>
    </div>
    <textarea class="field__input field__input--textarea sched-msg__text" rows="3" placeholder="Texto de este mensaje (va como caption si hay multimedia)...">${msg ? escapeHtml(msg.text || '') : ''}</textarea>
    <div class="sched-msg__opts">
      <label class="checkbox checkbox--sm">
        <input type="checkbox" class="sched-msg__forwarded" ${msg && msg.decorations && msg.decorations.forwarded ? 'checked' : ''} />
        <span>Reenviado</span>
      </label>
      <button class="btn btn--ghost btn--sm" data-tool="clearmedia" type="button" hidden>Quitar media</button>
      <button class="btn btn--ghost btn--sm" data-tool="targets" type="button">
        Destinos (<span class="sched-msg__count">${msg ? msg.target_jids.length : 0}</span>)
      </button>
    </div>
    <div class="media-preview sched-msg__mediapreview" hidden></div>
    <div class="sched-msg__copybox" hidden></div>
    <div class="sched-msg__targets" hidden></div>
  `

  // Estado interno de destinos y multimedia del row
  const jids = new Set(msg ? msg.target_jids : [])
  row._jids = jids
  row._media = (msg && msg.media) || null

  const renderMediaPreview = () => {
    const box = row.querySelector('.sched-msg__mediapreview')
    const clearBtn = row.querySelector('[data-tool="clearmedia"]')
    const nameEl = row.querySelector('.sched-msg__attachname')
    if (!row._media) {
      box.hidden = true
      box.innerHTML = ''
      clearBtn.hidden = true
      nameEl.hidden = true
      nameEl.textContent = ''
      return
    }
    nameEl.hidden = false
    nameEl.textContent = row._media.file_name || 'multimedia adjunta'
    clearBtn.hidden = false
    box.hidden = false
    box.innerHTML = mediaPreviewHtml(row._media)
  }
  renderMediaPreview()

  const renderTargetsList = () => {
    const accountId = Number(row.querySelector('.sched-msg__account').value)
    const cache = state.groupsByAccount[accountId] || { groups: [], newsletters: [] }
    const all = [...(cache.groups || []).map(g => ({ ...g, icon: '👥' })), ...(cache.newsletters || []).map(n => ({ ...n, icon: '📢' }))]
    const box = row.querySelector('.sched-msg__targets')
    if (all.length === 0) {
      box.innerHTML = '<div class="empty empty--sm">Esta cuenta no tiene grupos/canales en caché. Sincronizá desde Destinos (Publicar) primero.</div>'
    } else {
      box.innerHTML = all.map(item => {
        const jid = item.jid
        // Filas (mensajes) de la programación que tienen este destino elegido
        const rowsWith = Array.from(document.querySelectorAll('.sched-msg')).filter(r => r._jids && r._jids.has(jid))
        let dupeControl = ''
        if (rowsWith.length >= 2) {
          // Dos o más mensajes apuntan al mismo destino → elegir quién envía
          const opts = rowsWith.map(r => {
            const aId = Number(r.querySelector('.sched-msg__account').value)
            const a = state.accounts.find(x => x.id === aId)
            return { id: aId, label: a ? a.label : `Cuenta ${aId}`, warn: !!a && a.status !== 'connected' }
          })
          const validIds = new Set(opts.map(o => o.id))
          if (!(jid in state.schedAssign) || !validIds.has(state.schedAssign[jid])) {
            state.schedAssign[jid] = opts[0].id
          }
          dupeControl = dupePickerHtml(jid, opts, state.schedAssign[jid])
        } else if (rowsWith.length === 1 && rowsWith[0] !== row) {
          // Aviso informativo: otro mensaje ya tiene este destino
          const aId = Number(rowsWith[0].querySelector('.sched-msg__account').value)
          const a = state.accounts.find(x => x.id === aId)
          dupeControl = a ? `<span class="target-item__dupe">⇄ ya en ${escapeHtml(a.label)}</span>` : ''
        }
        return `
          <div class="target-row">
            <label class="target-item">
              <input type="checkbox" value="${escapeHtml(jid)}" ${jids.has(jid) ? 'checked' : ''} />
              <div style="flex:1; min-width:0;">
                <div class="target-item__name">
                  <span class="target-item__icon">${item.icon}</span>
                  ${escapeHtml(item.name || '(sin nombre)')}
                  ${item.is_admin === false ? (item.can_send === false
                    ? '<span class="target-item__tag target-item__tag--restricted">SOLO ADMINS</span>'
                    : '<span class="target-item__tag target-item__tag--member">MIEMBRO</span>') : ''}
                </div>
                <div class="target-item__jid">${escapeHtml(jid)}</div>
              </div>
            </label>
            ${dupeControl}
          </div>
        `
      }).join('')
      bindDupePickers(box, (jid2, accId) => {
        state.schedAssign[jid2] = accId
        // Las otras listas visibles muestran el mismo destino → sincronizar
        document.querySelectorAll('.sched-msg').forEach(r => {
          if (r !== row) {
            const t = r.querySelector('.sched-msg__targets')
            if (!t.hidden && r._renderTargets) r._renderTargets()
          }
        })
      })
      box.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) jids.add(cb.value)
          else jids.delete(cb.value)
          // Poda: si el destino dejó de estar duplicado, su elección ya no aplica
          if (state.schedAssign[cb.value]) {
            const owners = Array.from(document.querySelectorAll('.sched-msg')).filter(r => r._jids && r._jids.has(cb.value))
            if (owners.length < 2) delete state.schedAssign[cb.value]
          }
          row.querySelector('.sched-msg__count').textContent = String(jids.size)
          // Otras listas visibles pueden necesitar el aviso del duplicado nuevo/quitado
          refreshVisibleSchedTargets()
        })
      })
    }
    row.querySelector('.sched-msg__count').textContent = String(jids.size)
  }
  row._renderTargets = renderTargetsList

  row.querySelector('[data-tool="targets"]').addEventListener('click', () => {
    const box = row.querySelector('.sched-msg__targets')
    const willShow = box.hidden
    if (willShow) renderTargetsList()
    box.hidden = !willShow
  })

  row.querySelector('[data-tool="del"]').addEventListener('click', () => {
    if (wrap.children.length <= 1) { toast('Tenés que dejar al menos un mensaje.', 'error'); return }
    row.remove()
    // Los duplicados pueden cambiar al quitar una fila
    refreshVisibleSchedTargets()
  })

  // Cambiar cuenta: recargar la lista de destinos si está visible. Los jids
  // elegidos de la cuenta anterior que la nueva no tiene en caché se sueltan
  // (si no, el mensaje guardaría destinos que no le corresponden y el
  // contador mentiría).
  row.querySelector('.sched-msg__account').addEventListener('change', () => {
    const newAcc = Number(row.querySelector('.sched-msg__account').value)
    const cache = state.groupsByAccount[newAcc] || { groups: [], newsletters: [] }
    const valid = new Set([...(cache.groups || []), ...(cache.newsletters || [])].map(x => x.jid))
    if (row._jids) {
      for (const jid of Array.from(row._jids)) {
        if (!valid.has(jid)) row._jids.delete(jid)
      }
    }
    refreshVisibleSchedTargets()
  })

  // Cargar plantilla dentro de este mensaje (texto + decoraciones + multimedia)
  row.querySelector('.sched-msg__tpl').addEventListener('change', async e => {
    const id = Number(e.target.value)
    if (!id) return
    const t = state.templates.find(x => x.id === id)
    if (!t) return
    row.querySelector('.sched-msg__text').value = t.text || ''
    row.querySelector('.sched-msg__forwarded').checked = !!(t.decorations && t.decorations.forwarded)
    row._media = t.media || null
    renderMediaPreview()
    e.target.value = ''
    toast('Plantilla cargada en el mensaje.', 'success')
  })

  // Adjuntar multimedia propia del mensaje
  row.querySelector('.sched-msg__attachbtn').addEventListener('click', () => {
    row.querySelector('.sched-msg__file').click()
  })
  row.querySelector('.sched-msg__file').addEventListener('change', async e => {
    const file = e.target.files?.[0]
    if (!file) return
    const media = await uploadMediaFile(file)
    if (media) {
      row._media = media
      renderMediaPreview()
    }
    e.target.value = ''
  })

  row.querySelector('[data-tool="clearmedia"]').addEventListener('click', () => {
    row._media = null
    renderMediaPreview()
  })

  // Copiar este mensaje a varias cuentas de una vez
  row.querySelector('[data-tool="copy"]').addEventListener('click', () => {
    const box = row.querySelector('.sched-msg__copybox')
    if (!box.hidden) { box.hidden = true; return }

    const currentAccountId = Number(row.querySelector('.sched-msg__account').value)
    const others = state.accounts.filter(a => a.id !== currentAccountId)
    if (others.length === 0) { toast('No hay otras cuentas para copiar.', 'error'); return }

    box.innerHTML = `
      <div class="copybox">
        <div class="field__hint">Copiar este mensaje (texto + multimedia) a:</div>
        <div class="copybox__accounts">
          ${others.map(a => `
            <label class="checkbox checkbox--sm">
              <input type="checkbox" class="copybox__acc" value="${a.id}" />
              <span>${escapeHtml(a.label)}</span>
            </label>
          `).join('')}
        </div>
        <button class="btn btn--ghost btn--sm" data-tool="applycopy" type="button">Copiar ahora</button>
      </div>
    `
    box.hidden = false

    box.querySelector('[data-tool="applycopy"]').addEventListener('click', () => {
      const selected = Array.from(box.querySelectorAll('.copybox__acc:checked')).map(cb => Number(cb.value))
      if (selected.length === 0) { toast('Elegí al menos una cuenta.', 'error'); return }
      const text = row.querySelector('.sched-msg__text').value
      const forwarded = row.querySelector('.sched-msg__forwarded').checked
      const decorations = {}
      if (forwarded) decorations.forwarded = true
      for (const accId of selected) {
        addSchedMessageRow({
          account_id: accId,
          text,
          target_jids: [],
          decorations: Object.keys(decorations).length > 0 ? decorations : null,
          media: row._media
        })
      }
      box.hidden = true
      toast(`Mensaje copiado a ${selected.length} cuenta${selected.length !== 1 ? 's' : ''}. Elegí los destinos de cada una.`, 'success')
    })
  })

  wrap.appendChild(row)
}

function collectScheduleData () {
  const name = document.getElementById('sched-name').value.trim()
  const type = document.getElementById('sched-type').value

  if (!name) { toast('Poné un nombre a la programación.', 'error'); return null }

  let scheduled_at = null
  let recur_time = null
  let recur_times = null
  let recur_dow = null
  let recur_dom = null
  let interval_minutes = null
  let window_start = null
  let window_end = null

  if (type === 'once') {
    const dtv = document.getElementById('sched-datetime').value
    if (!dtv) { toast('Elegí fecha y hora.', 'error'); return null }
    scheduled_at = new Date(dtv).getTime()
  } else if (type === 'interval') {
    const iv = Number(document.getElementById('sched-interval').value)
    if (!Number.isInteger(iv) || iv < 1 || iv > 1440) { toast('El intervalo debe estar entre 1 y 1440 minutos.', 'error'); return null }
    interval_minutes = iv
    if (document.getElementById('sched-window-on').checked) {
      const ws = hhmmToMinutes(document.getElementById('sched-window-start').value)
      const we = hhmmToMinutes(document.getElementById('sched-window-end').value)
      if (ws === null || we === null || ws >= we) { toast('La ventana horaria está mal: el inicio debe ser antes del fin.', 'error'); return null }
      window_start = ws
      window_end = we
    }
  } else {
    if (state.schedTimes.length === 0) { toast('Agregá al menos un horario del día.', 'error'); return null }
    recur_times = state.schedTimes
    recur_time = state.schedTimes[0]
    if (type === 'weekly') recur_dow = Number(document.getElementById('sched-dow').value)
    if (type === 'monthly') recur_dom = Number(document.getElementById('sched-dom').value)
  }

  const messages = []
  for (const row of document.querySelectorAll('.sched-msg')) {
    const accountId = Number(row.querySelector('.sched-msg__account').value)
    if (!accountId) { toast('Uno de los mensajes no tiene cuenta elegida.', 'error'); return null }
    const text = row.querySelector('.sched-msg__text').value.trim()
    if (!text && !row._media) { toast('Uno de los mensajes está sin texto y sin multimedia.', 'error'); return null }
    const jids = Array.from(row._jids)
    if (jids.length === 0) { toast('Uno de los mensajes no tiene destinos.', 'error'); return null }
    const decorations = {}
    if (row.querySelector('.sched-msg__forwarded').checked) decorations.forwarded = true
    messages.push({
      account_id: accountId,
      target_jids: jids,
      text,
      decorations: Object.keys(decorations).length > 0 ? decorations : undefined,
      media_id: row._media ? row._media.id : undefined
    })
  }

  if (messages.length === 0) { toast('Agregá al menos un mensaje.', 'error'); return null }

  // Elección de cuenta para duplicados: sólo jids todavía repetidos entre
  // mensajes y cuya cuenta elegida siga participando.
  const jidOwners = new Map()
  for (const m of messages) {
    for (const jid of m.target_jids) {
      if (!jidOwners.has(jid)) jidOwners.set(jid, new Set())
      jidOwners.get(jid).add(m.account_id)
    }
  }
  const assignMap = {}
  for (const [jid, accId] of Object.entries(state.schedAssign)) {
    const owners = jidOwners.get(jid)
    if (owners && owners.size >= 2 && owners.has(accId)) assignMap[jid] = accId
  }

  return {
    name,
    sched_type: type,
    scheduled_at,
    recur_time,
    recur_times,
    recur_dow,
    recur_dom,
    interval_minutes,
    window_start,
    window_end,
    tz_offset_min: new Date().getTimezoneOffset(),
    messages,
    assign_map: Object.keys(assignMap).length > 0 ? assignMap : undefined
  }
}

async function saveSchedule () {
  const data = collectScheduleData()
  if (!data) return

  const btn = document.getElementById('btn-save-sched')
  const btnText = btn.querySelector('.btn__text')
  const btnSpinner = btn.querySelector('.btn__spinner')
  btn.disabled = true
  btnText.textContent = 'Guardando…'
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
    document.getElementById('schedule-editor').hidden = true
    loadSchedules()
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  } finally {
    btn.disabled = false
    btnText.textContent = 'Guardar programación'
    btnSpinner.hidden = true
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
  // Precargar plantillas para el selector del editor (silencioso)
  try { await loadTemplates() } catch { /* la vista mostrará el error */ }
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
document.getElementById('btn-new-sched').addEventListener('click', () => openScheduleEditor(null))
document.getElementById('btn-add-sched-msg').addEventListener('click', () => addSchedMessageRow(null))
document.getElementById('btn-save-sched').addEventListener('click', saveSchedule)
document.getElementById('btn-cancel-sched').addEventListener('click', () => {
  document.getElementById('schedule-editor').hidden = true
})
document.getElementById('sched-type').addEventListener('change', updateSchedTypeFields)
document.getElementById('btn-add-time').addEventListener('click', addSchedTime)
document.getElementById('sched-window-on').addEventListener('change', updateSchedTypeFields)
document.getElementById('btn-add-admin').addEventListener('click', addAdmin)

setupMediaAttach()
checkSession()
