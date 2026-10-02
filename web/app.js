import { store } from './store.js'
import { connect, subscribe } from './net.js'
import { initChat } from './chat.js'
import { initMove, releaseAllControls, onResize } from './move.js'
import { initBag, closeSheet } from './bag.js'
import { initMore } from './more.js'

function setBar (id, value, max) {
  const fill = document.getElementById(id)
  if (!fill) return
  fill.style.width = value == null ? '0%' : `${Math.max(0, Math.min(100, (value / max) * 100))}%`
}

function renderStatusBar () {
  const session = store.session()
  const dot = document.getElementById('state-dot')
  dot.className = `dot ${session?.state || 'stopped'}`
  const label = session ? session.id : 'Choose a session'
  document.getElementById('session-label').textContent = label
  const status = store.status
  document.getElementById('hp-value').textContent = status?.hp == null ? '—' : `${status.hp} / 20`
  document.getElementById('food-value').textContent = status?.food == null ? '—' : `${status.food} / 20`
  document.getElementById('xp-value').textContent = status?.xpLvl ?? '—'
  document.getElementById('session-picker').title = session ? `${session.id} · ${session.state}` : 'Choose or create a session'
  if (status) {
    document.getElementById('coords').textContent = `x ${status.x} y ${status.y} z ${status.z}`
    setBar('hp-fill', status.hp, 20)
    setBar('food-fill', status.food, 20)
    setBar('xp-fill', status.xpProgress, 1)
    document.getElementById('actionbar').textContent = status.actionbar || ''
  } else {
    document.getElementById('coords').textContent = '–'
    setBar('hp-fill', null, 20)
    setBar('food-fill', null, 20)
    setBar('xp-fill', null, 1)
    document.getElementById('actionbar').textContent = ''
  }
}

function renderSessionMenu () {
  const menu = document.getElementById('session-menu')
  menu.textContent = ''
  if (store.sessions.length === 0) {
    const empty = document.createElement('button')
    empty.type = 'button'
    empty.textContent = 'Create a session →'
    empty.addEventListener('click', () => {
      selectTab('more')
      closeSessionMenu()
    })
    menu.appendChild(empty)
    return
  }
  for (const session of store.sessions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(session.id === store.sessionId))
    const dot = document.createElement('span')
    dot.className = `dot ${session.state}`
    button.appendChild(dot)
    button.appendChild(document.createTextNode(` ${session.id}`))
    button.addEventListener('click', () => {
      releaseAllControls(true)
      store.setSession(session.id)
      subscribe(session.id)
      closeSessionMenu()
    })
    menu.appendChild(button)
  }
}

function showToast (text, kind = 'info') {
  const toasts = document.getElementById('toasts')
  const toast = document.createElement('div')
  toast.className = `toast ${kind}`
  toast.textContent = text
  toasts.appendChild(toast)
  setTimeout(() => toast.remove(), 6000)
}

function showBanner (id, nodes) {
  const banner = document.getElementById(id)
  banner.textContent = ''
  for (const node of nodes) banner.appendChild(node)
  banner.classList.remove('hidden')
  return banner
}

function renderMsaBanner () {
  if (store.tokenRejected) return
  const withMsa = store.sessions.find(s => s.pendingMsa && s.pendingMsa.expiresAt > Date.now())
  const banner = document.getElementById('disconnect-banner')
  if (withMsa) {
    const text = document.createElement('div')
    text.textContent = `${withMsa.id} needs a Microsoft sign-in: code ${withMsa.pendingMsa.code}`
    const link = document.createElement('a')
    link.href = withMsa.pendingMsa.url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = withMsa.pendingMsa.url
    link.style.color = 'var(--info)'
    showBanner('disconnect-banner', [text, link])
    return
  }
  if (!store.connected && !store.tokenRejected) {
    showBanner('disconnect-banner', [document.createTextNode('Disconnected — reconnecting…')])
    return
  }
  banner.classList.add('hidden')
}

function closeSessionMenu () {
  document.getElementById('session-menu').classList.add('hidden')
  document.getElementById('session-picker').setAttribute('aria-expanded', 'false')
}

function selectTab (name) {
  if (name !== 'move') releaseAllControls(true)
  closeSheet()
  for (const button of document.querySelectorAll('.tabbtn')) {
    const active = button.dataset.tab === name
    button.classList.toggle('active', active)
    if (active) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.id === `tab-${name}`)
  if (name === 'move') onResize()
}

function initShell () {
  const menu = document.getElementById('session-menu')
  document.getElementById('session-picker').addEventListener('click', () => {
    menu.classList.toggle('hidden')
    document.getElementById('session-picker').setAttribute('aria-expanded', String(!menu.classList.contains('hidden')))
  })
  document.getElementById('setup-open').addEventListener('click', () => selectTab('more'))
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeSessionMenu()
      closeSheet()
    }
  })
  document.addEventListener('click', event => {
    if (!menu.contains(event.target) && !document.getElementById('session-picker').contains(event.target)) {
      closeSessionMenu()
    }
  })

  for (const button of document.querySelectorAll('.tabbtn')) {
    button.addEventListener('click', () => {
      selectTab(button.dataset.tab)
    })
  }

  store.on('sessions', () => {
    renderSessionMenu()
    renderStatusBar()
    renderMsaBanner()
  })
  store.on('session', () => {
    renderStatusBar()
    renderSessionMenu()
    closeSheet()
  })
  store.on('hello', () => {
    renderStatusBar()
    renderSessionMenu()
    renderMsaBanner()
  })
  store.on('status', renderStatusBar)
  store.on('snapshot', () => {
    renderStatusBar()
  })
  store.on('connection', connected => {
    const indicator = document.getElementById('connection-state')
    indicator.textContent = connected ? '● Daemon online' : '○ Offline'
    indicator.classList.toggle('online', connected)
    if (!connected) releaseAllControls(false)
    if (connected) {
      renderMsaBanner()
    } else {
      renderMsaBanner()
    }
  })
  store.on('token-rejected', () => {
    store.tokenRejected = true
    const text = document.createElement('div')
    text.textContent = 'The token was rejected. Open the link printed at startup, or run `node src/main.js --print-url` and use that URL.'
    showBanner('disconnect-banner', [text])
  })
  store.on('token-missing', () => {
    const text = document.createElement('div')
    text.textContent = 'No token. Open the URL printed at startup (or run `--print-url`), which includes #t=<token>.'
    showBanner('disconnect-banner', [text])
  })
  store.on('alert', alert => {
    showToast(alert.text, alert.kind)
    if (alert.kind === 'damage' && document.visibilityState === 'visible' && navigator.vibrate) {
      try {
        navigator.vibrate(100)
      } catch {}
    }
  })
  store.on('msa', () => renderMsaBanner())
  store.on('goto', msg => {
    if (msg.phase === 'failed') showToast(`Pathfinding failed: ${msg.detail || 'unknown'}`, 'stopped')
    else if (msg.phase === 'arrived') showToast('Arrived', 'info')
  })
  store.on('err', err => {
    if (err.code !== 'rate_limited') showToast(`${err.code}: ${err.msg}`, 'stopped')
  })
  window.addEventListener('golemlink-toast', event => showToast(event.detail, 'info'))

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseAllControls(true)
  })
  window.addEventListener('blur', () => releaseAllControls(true))
  window.addEventListener('pagehide', () => {
    releaseAllControls(true)
  })
}

function main () {
  initShell()
  initChat()
  initMove()
  initBag()
  initMore()
  connect()
  renderStatusBar()
}

main()
