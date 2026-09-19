/* Publisher Manager — Lógica del panel web (mobile-first) */

const API = '/api'

const state = {
  groups: [],
  newsletters: [],
  selectedJids: new Set(),
  publishing: false,
  activeTab: 'groups',
  mediaFile: null
}

/* ---------- Helpers ---------- */

async function api (path, options = {}) {
  const fetchOpts = { ...options }
  if (!fetchOpts.body) {
    fetchOpts.headers = { ...(fetchOpts.headers || {}) }
    delete fetchOpts.headers['Content-Type']
  } else if (!fetchOpts.headers) {
    fetchOpts.headers = { 'Content-Type': 'application/json' }
  }
  const res = await fetch(API + path, fetchOpts)
  const data = await res.json().catch(() => ({}))
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
  const d = new Date(ms)
  return d.toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

/* ---------- Navegación entre vistas ---------- */

function switchView (viewName) {
  document.querySelectorAll('.nav-item, .bottom-nav__item').forEach(n => n.classList.remove('active'))
  document.querySelectorAll(`[data-view="${viewName}"]`).forEach(n => n.classList.add('active'))
  document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'))
  document.getElementById('view-' + viewName).classList.add('view--active')
  if (viewName === 'history') loadHistory()
}

document.querySelectorAll('[data-view]').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault()
    switchView(item.dataset.view)
  })
})

/* ---------- Tabs: grupos vs canales ---------- */

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab
    state.activeTab = target
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    renderTargets()
  })
})

/* ---------- Carga de grupos y canales ---------- */

async function loadGroups () {
  try {
    const data = await api('/groups')
    state.groups = data.groups || []
    renderTargets()
    updatePublishButton()
  } catch (err) {
    toast('Error cargando grupos: ' + err.message, 'error')
  }
}

async function loadNewsletters () {
  try {
    const data = await api('/newsletters')
    state.newsletters = data.newsletters || []
    renderTargets()
    updatePublishButton()
  } catch (err) {
    toast('Error cargando canales: ' + err.message, 'error')
  }
}

async function refreshGroups () {
  const btn = document.getElementById('btn-refresh-groups')
  const originalText = btn.textContent
  btn.disabled = true
  btn.textContent = '…'
  try {
    const data = await api('/groups/refresh', { method: 'POST' })
    state.groups = data.groups || []
    renderTargets()
    updatePublishButton()
    toast(`Sincronizados ${data.total} grupos. ${data.admin_count} admin.`, 'success')
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
    const data = await api('/newsletters/refresh', { method: 'POST' })
    state.newsletters = data.newsletters || []
    renderTargets()
    updatePublishButton()
    toast(`Sincronizados ${data.total} canales. ${data.admin_count} admin.`, 'success')
  } catch (err) {
    toast('Error: ' + err.message, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = originalText
  }
}

/* ---------- Renderizado de destinos según tab activa ---------- */

function renderTargets () {
  const listEl = document.getElementById('targets-list')
  const countEl = document.getElementById('targets-count')
  const tabGroupsCount = document.getElementById('tab-groups-count')
  const tabNewslettersCount = document.getElementById('tab-newsletters-count')

  const groupsTotal = state.groups.length
  const groupsAdmin = state.groups.filter(g => g.is_admin).length
  const channelsAdmin = state.newsletters.length

  tabGroupsCount.textContent = groupsTotal
  tabNewslettersCount.textContent = channelsAdmin

  const currentList = state.activeTab === 'groups' ? state.groups : state.newsletters
  const label = state.activeTab === 'groups' ? 'grupos' : 'canales'

  if (currentList.length === 0) {
    const refreshBtn = state.activeTab === 'groups' ? '👥 Grupos' : '📢 Canales'
    const msg = state.activeTab === 'groups'
      ? `No hay ${label} en el cache.`
      : `No hay ${label} admin en el cache.`
    listEl.innerHTML = `<div class="empty">${msg}<br><br>Pulsá <strong>${refreshBtn}</strong> arriba para sincronizar.</div>`
    countEl.textContent = `0 ${label}`
    return
  }

  if (state.activeTab === 'groups') {
    countEl.textContent = `${groupsTotal} · ${groupsAdmin} admin`
  } else {
    countEl.textContent = `${channelsAdmin} admin`
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
          : `<span class="target-item__admin-badge target-item__admin-badge--member">👤 MIEMBRO</span>`)
      : ''
    return `
      <label class="target-item">
        <input type="checkbox" data-jid="${escapeHtml(jid)}" ${state.selectedJids.has(jid) ? 'checked' : ''} />
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
    `
  }).join('')

  listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const jid = cb.dataset.jid
      if (cb.checked) state.selectedJids.add(jid)
      else state.selectedJids.delete(jid)
      updatePublishButton()
    })
  })

  const selectAll = document.getElementById('select-all')
  selectAll.checked = currentList.length > 0 && currentList.every(g => state.selectedJids.has(g.jid))
}

function updatePublishButton () {
  const btn = document.getElementById('fab-publish')
  const text = document.getElementById('publish-text').value.trim()
  const hasMedia = !!state.mediaFile
  const hasContent = text.length > 0 || hasMedia
  btn.disabled = state.publishing || !hasContent || state.selectedJids.size === 0
}

/* ---------- Select all ---------- */

document.getElementById('select-all').addEventListener('change', e => {
  const currentList = state.activeTab === 'groups' ? state.groups : state.newsletters
  if (e.target.checked) {
    currentList.forEach(g => state.selectedJids.add(g.jid))
  } else {
    currentList.forEach(g => state.selectedJids.delete(g.jid))
  }
  renderTargets()
  updatePublishButton()
})

/* ---------- Texto ---------- */

document.getElementById('publish-text').addEventListener('input', e => {
  const len = e.target.value.length
  document.getElementById('char-count').textContent = `${len} caracter${len !== 1 ? 'es' : ''}`
  updatePublishButton()
})

/* ---------- Multimedia (dropzone fijo para móvil) ---------- */

function setupDropzone () {
  const dz = document.getElementById('dropzone')
  const input = document.getElementById('media-input')
  const removeBtn = document.getElementById('media-remove')

  // Click en dropzone abre selector — pero NO si ya hay preview visible
  // (tocar la X para quitar, no para abrir otro selector)
  dz.addEventListener('click', (e) => {
    // Si el click fue en el botón remove o dentro de él, no abrir selector
    if (e.target === removeBtn || removeBtn.contains(e.target)) return
    // Si ya hay preview mostrándose, no abrir selector
    const preview = document.getElementById('media-preview')
    if (preview && !preview.hidden) return
    input.click()
  })

  // Keyboard support
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      input.click()
    }
  })

  // Change handler — reset value para que change event dispare siempre
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) {
      handleFile(input.files[0])
      // Reset crítico para móvil: sin esto, no se puede seleccionar el mismo archivo
      input.value = ''
    }
  })

  // Drag & drop (desktop)
  ;['dragenter', 'dragover'].forEach(evt => {
    dz.addEventListener(evt, (e) => {
      e.preventDefault()
      e.stopPropagation()
      dz.classList.add('dragover')
    })
  })
  ;['dragleave', 'drop'].forEach(evt => {
    dz.addEventListener(evt, (e) => {
      e.preventDefault()
      e.stopPropagation()
      dz.classList.remove('dragover')
    })
  })
  dz.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer.files
    if (files && files[0]) {
      handleFile(files[0])
    }
  })

  // Botón remove — usar pointerdown (más confiable que click en móvil)
  // y prevenir TODA la propagación para que no se dispare el click del dropzone
  const handleRemove = (e) => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    clearMedia()
    return false
  }
  removeBtn.addEventListener('click', handleRemove)
  removeBtn.addEventListener('pointerdown', handleRemove)
  removeBtn.addEventListener('touchstart', handleRemove, { passive: false })
}

function handleFile (file) {
  if (file.size > 50 * 1024 * 1024) {
    toast('Archivo demasiado grande (máx 50MB).', 'error')
    return
  }

  state.mediaFile = file

  const placeholder = document.getElementById('dropzone-placeholder')
  const preview = document.getElementById('media-preview')
  const imgEl = document.getElementById('preview-img')
  const videoEl = document.getElementById('preview-video')
  const fileEl = document.getElementById('preview-file')
  const filenameEl = document.getElementById('preview-filename')

  imgEl.hidden = true
  videoEl.hidden = true
  fileEl.hidden = true

  if (file.type.startsWith('image/')) {
    imgEl.src = URL.createObjectURL(file)
    imgEl.hidden = false
  } else if (file.type.startsWith('video/')) {
    videoEl.src = URL.createObjectURL(file)
    videoEl.hidden = false
  } else {
    filenameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`
    fileEl.hidden = false
  }

  placeholder.hidden = true
  preview.hidden = false
  updatePublishButton()
}

function clearMedia () {
  state.mediaFile = null
  const input = document.getElementById('media-input')
  input.value = ''
  document.getElementById('dropzone-placeholder').hidden = false
  document.getElementById('media-preview').hidden = true
  // Limpiar URLs para liberar memoria
  document.getElementById('preview-img').src = ''
  document.getElementById('preview-video').src = ''
  updatePublishButton()
}

/* ---------- Publicar ---------- */

async function publish () {
  const text = document.getElementById('publish-text').value.trim()
  const mediaFile = state.mediaFile
  if (state.selectedJids.size === 0) return
  if (!text && !mediaFile) {
    toast('Debe haber al menos texto o un archivo multimedia.', 'error')
    return
  }

  const btn = document.getElementById('fab-publish')
  const btnText = btn.querySelector('.fab__text')
  const btnSpinner = btn.querySelector('.fab__spinner')

  state.publishing = true
  btn.disabled = true
  btnText.textContent = 'Enviando…'
  btnSpinner.hidden = false

  const resultsEl = document.getElementById('publish-results')
  resultsEl.hidden = true

  const decorations = {}
  if (document.getElementById('dec-forwarded').checked) {
    decorations.forwarded = true
  }

  const formData = new FormData()
  if (text) formData.append('text', text)
  formData.append('target_jids', JSON.stringify(Array.from(state.selectedJids)))
  if (Object.keys(decorations).length > 0) {
    formData.append('decorations', JSON.stringify(decorations))
  }
  if (mediaFile) {
    formData.append('media', mediaFile)
  }

  try {
    const res = await fetch(API + '/publish', {
      method: 'POST',
      body: formData
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`)
    }

    renderResults(data)
    toast(`Enviado: ${data.sent}/${data.total} ✓`, data.failed === 0 ? 'success' : 'error')
  } catch (err) {
    toast('Error publicando: ' + err.message, 'error')
  } finally {
    state.publishing = false
    btn.disabled = false
    btnText.textContent = 'Publicar'
    btnSpinner.hidden = true
    updatePublishButton()
  }
}

document.getElementById('fab-publish').addEventListener('click', publish)

function renderResults (data) {
  const el = document.getElementById('publish-results')
  el.hidden = false

  const findName = (jid) => {
    const g = state.groups.find(x => x.jid === jid)
    if (g) return g.name
    const n = state.newsletters.find(x => x.jid === jid)
    if (n) return n.name
    return jid
  }

  el.innerHTML = `
    <div class="results__header">
      <div class="results__title">Resultado del envío</div>
      <div class="results__stats">
        <span class="results__stat--ok">✓ ${data.sent} OK</span>
        <span class="results__stat--fail">✗ ${data.failed} fallidos</span>
      </div>
    </div>
    <div>
      ${data.results.map(r => `
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

/* ---------- Botones refrescar ---------- */

document.getElementById('btn-refresh-groups').addEventListener('click', refreshGroups)
document.getElementById('btn-refresh-newsletters').addEventListener('click', refreshNewsletters)

// Mobile sync button (sincroniza ambos)
document.getElementById('mobile-sync').addEventListener('click', async () => {
  await Promise.all([refreshGroups(), refreshNewsletters()])
})

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
      if (item.media_name) {
        const icon = item.media_type === 'image' ? '🖼️' :
                     item.media_type === 'video' ? '🎬' :
                     item.media_type === 'audio' ? '🎵' :
                     '📎'
        decBadges.push(`${icon} ${item.media_name.slice(0, 20)}${item.media_name.length > 20 ? '…' : ''}`)
      }

      return `
        <div class="history-batch" data-batch-id="${item.id}">
          <div class="history-batch__header" onclick="toggleBatchDetails(${item.id})">
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
  } catch (err) {
    listEl.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`
  }
}

window.toggleBatchDetails = async function (batchId) {
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
      const findName = (jid) => {
        const g = state.groups.find(x => x.jid === jid)
        if (g) return g.name
        const n = state.newsletters.find(x => x.jid === jid)
        if (n) return n.name
        return null
      }
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

/* ---------- Init ---------- */

setupDropzone()
loadGroups()
loadNewsletters()
