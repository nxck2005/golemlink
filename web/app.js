import { store } from './store.js'
import { connect, send, subscribe } from './net.js'
import { initChat } from './chat.js'
import { initMove, releaseAllControls, onResize, hasMomentary } from './move.js'
import { initBag, renderBag } from './bag.js'
import { initMore } from './more.js'

function setBar (id, value, max) {
  const fill = document.querySelector(`#${id} span`)
  if (!fill) return
  fill.style.width = value == null ? '0%' : `${Math.max(0, Math.min(100, (value / max) * 100))}%`
}

function renderStatusBar () {
  const session = store.session()
  const dot = document.getElementById('state-dot')
  dot.className = `dot ${session?.state || 'stopped'}`
  const label = session ? session.id : 'no session'
  document.getElementById('session-label').textContent = label
  const status = store.status
  if (status) {
    document.getElementById('coords').textContent = `x ${status.x} y ${status.y} z ${status.z}`
    setBar('hp-fill', status.hp, 20)
    setBar('food-fill', status.food, 20)
    setBar('xp-fill', status.xpLvl, 30)
    document.getElementById('actionbar').textContent = status.actionbar || ''
  } else {
    document.getElementById('coords').textContent = '–'
    setBar('hp-fill', null, 20)
    setBar('food-fill', null, 20)
    setBar('xp-fill', null, 30)
    document.getElementById('actionbar').textContent = ''
  }
}

function renderSessionMenu () {
  const menu = document.getElementById('session-menu')
  menu.textContent = ''
  if (store.sessions.length === 0) {
    const empty = document.createElement('button')
    empty.type = 'button'
    empty.textContent = 'No sessions (More → Sessions)'
    menu.appendChild(empty)
    return
  }
  for (const session of store.sessions) {
    const button = document.createElement('button')
    button.type = 'button'
    const dot = document.createElement('span')
    dot.className = `dot ${session.state}`
    button.appendChild(dot)
    button.appendChild(document.createTextNode(` ${session.id}`))
    button.addEventListener('click', () => {
      store.setSession(session.id)
      subscribe(session.id)
      menu.classList.add('hidden')
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
  const withMsa = store.sessions.find(s => s.pendingMsa)
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

function initShell () {
  const menu = document.getElementById('session-menu')
  document.getElementById('session-picker').addEventListener('click', () => menu.classList.toggle('hidden'))
  document.addEventListener('click', event => {
    if (!menu.contains(event.target) && !document.getElementById('session-picker').contains(event.target)) {
      menu.classList.add('hidden')
    }
  })

  for (const button of document.querySelectorAll('.tabbtn')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tabbtn')) other.classList.toggle('active', other === button)
      for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('active', tab.id === `tab-${button.dataset.tab}`)
      }
      if (button.dataset.tab === 'move') onResize()
    })
  }

  store.on('sessions', () => {
    renderSessionMenu()
    renderStatusBar()
    renderMsaBanner()
  })
  store.on('session', () => {
    renderStatusBar()
  })
  store.on('status', renderStatusBar)
  store.on('snapshot', () => {
    renderStatusBar()
  })
  store.on('connection', connected => {
    if (connected) {
      showToast('connected', 'info')
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
    if (document.visibilityState === 'hidden' && hasMomentary()) releaseAllControls(true)
  })
  window.addEventListener('pagehide', () => {
    if (hasMomentary()) releaseAllControls(true)
  })
}

function main () {
  initShell()
  initChat()
  initMove()
  initBag()
  initMore()
  connect()
  setInterval(renderStatusBar, 1000)
}

main()
