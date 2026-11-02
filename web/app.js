// The shell: sign-in, routing between views, the session rail and picker,
// the vitals bars, banners and toasts.
import { store } from './store.js'
import { connect, disconnect, subscribe } from './net.js'
import { checkLogin, initLogin, signOut } from './login.js'
import { initChat, onChatChange, recentLines, makeLine } from './chat.js'
import { initMove, releaseAllControls, onResize } from './move.js'
import { initPlay, playKey, closeMenu, closeWindow, menuOpen } from './play.js'
import { initSetup, renderLogins } from './setup.js'
import { useTextures, texturesVersion } from './items.js'
import { el, sessionName, sessionStatus, dotClass } from './format.js'

const VIEWS = ['play', 'move', 'setup', 'chat']
const DESKTOP = window.matchMedia('(min-width: 1100px)')

// --- routing ---------------------------------------------------------------
function setView (name, { push = true } = {}) {
  if (!VIEWS.includes(name)) name = 'play'
  if (name === 'chat' && DESKTOP.matches) name = 'play'
  const previous = document.body.dataset.view
  if (previous === 'move' && name !== 'move') releaseAllControls(true)
  closeMenu()
  closeSessionMenu()
  document.body.dataset.view = name
  for (const button of document.querySelectorAll('[data-view]')) {
    if (button === document.body) continue
    if (button.dataset.view === name) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  if (name === 'chat') {
    document.getElementById('chat-tab').classList.remove('unread')
    const log = document.getElementById('chat-log')
    log.scrollTop = log.scrollHeight
  }
  if (name === 'move') requestAnimationFrame(onResize)
  if (name === 'setup') renderLogins()
  if (push && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
  renderTop()
}

// --- top bars and session pickers -------------------------------------------
function setBar (id, value, max, text) {
  document.getElementById(id).textContent = text
  document.getElementById(`${id}-fill`).style.width = value == null ? '0%' : `${Math.max(0, Math.min(100, (value / max) * 100))}%`
}

function serverLabel (session) {
  const server = store.servers.find(s => s.id === session?.server)
  if (!server) return ''
  return server.host + (server.port && server.port !== 25565 ? `:${server.port}` : '')
}

function renderTop () {
  const session = store.session()
  const status = store.status
  const view = document.body.dataset.view
  const titles = { setup: 'Setup', move: session ? sessionName(session.id) : 'Move and map' }
  document.getElementById('top-title').textContent = titles[view] || (session ? sessionName(session.id) : 'No session')
  const sub = view === 'setup'
    ? 'Sessions, servers, accounts and devices'
    : session ? [sessionStatus(session), serverLabel(session)].filter(Boolean).join(', ') : 'Start a session in Setup'
  document.getElementById('top-sub').textContent = sub

  const hp = status?.hp == null ? null : Math.round(status.hp)
  const food = status?.food ?? null
  setBar('bar-hp', hp, 20, hp == null ? '–' : `${hp} / 20`)
  setBar('bar-food', food, 20, food == null ? '–' : `${food} / 20`)
  document.getElementById('bar-lv').textContent = status?.xpLvl ?? '–'
  document.getElementById('bar-lv-fill').style.width = status?.xpProgress == null ? '0%' : `${Math.round(status.xpProgress * 100)}%`
  document.getElementById('p-hp').textContent = hp ?? '–'
  document.getElementById('p-food').textContent = food ?? '–'
  document.getElementById('p-lv').textContent = status?.xpLvl ?? '–'

  document.getElementById('picker-dot').className = dotClass(session)
  document.getElementById('picker-label').textContent = session ? sessionName(session.id) : 'No session'

  const actionbar = document.getElementById('actionbar')
  actionbar.textContent = status?.actionbar || ''
  actionbar.classList.toggle('hidden', !status?.actionbar)
}

function chooseSession (id) {
  if (id === store.sessionId) return
  releaseAllControls(true)
  store.setSession(id)
  subscribe(id)
}

function renderRail () {
  const box = document.getElementById('rail-sessions')
  box.textContent = ''
  for (const session of store.sessions) {
    const button = el('button', 'rail-sess')
    button.type = 'button'
    if (session.id === store.sessionId) button.setAttribute('aria-current', 'true')
    button.append(el('span', dotClass(session)), el('span', 'n', sessionName(session.id)), el('span', 's', sessionStatus(session)))
    button.addEventListener('click', () => {
      chooseSession(session.id)
      if (document.body.dataset.view === 'setup') setView('play')
    })
    box.appendChild(button)
  }
  if (!store.sessions.length) box.appendChild(el('p', 'rail-empty t3 small', 'No sessions yet'))
}

function renderSessionMenu () {
  const menu = document.getElementById('session-menu')
  menu.textContent = ''
  for (const session of store.sessions) {
    const item = el('button', 'm-item')
    item.type = 'button'
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(session.id === store.sessionId))
    item.append(el('span', dotClass(session)), el('span', '', sessionName(session.id)), el('span', 's', sessionStatus(session)))
    item.addEventListener('click', () => {
      chooseSession(session.id)
      closeSessionMenu()
    })
    menu.appendChild(item)
  }
  const manage = el('button', 'm-item quiet', store.sessions.length ? 'Manage sessions' : 'Start a session')
  manage.type = 'button'
  manage.addEventListener('click', () => setView('setup'))
  menu.appendChild(manage)
}

function closeSessionMenu () {
  document.getElementById('session-menu').classList.add('hidden')
  document.getElementById('session-picker').setAttribute('aria-expanded', 'false')
}

function renderUser () {
  const name = store.me?.username || store.hello?.user || ''
  document.getElementById('rail-user').textContent = name
  document.getElementById('rail-avatar').textContent = name.slice(0, 1) || '?'
}

// --- recent chat on the phone Play view -------------------------------------
function renderRecent () {
  const box = document.getElementById('recent-chat')
  box.textContent = ''
  const lines = recentLines(4)
  document.getElementById('recent-panel').classList.toggle('hidden', !lines.length)
  for (const line of lines) box.appendChild(makeLine(line))
}

// --- banners and toasts -------------------------------------------------------
function showToast (text, kind = 'info') {
  const toasts = document.getElementById('toasts')
  const toast = el('div', `toast ${kind}`, text)
  toasts.appendChild(toast)
  while (toasts.childElementCount > 4) toasts.firstElementChild.remove()
  setTimeout(() => toast.remove(), 6000)
}

function renderBanner () {
  const banner = document.getElementById('banner')
  banner.textContent = ''
  banner.className = 'banner hidden'
  if (store.signedOut) return
  const msa = store.sessions.find(s => s.pendingMsa && s.pendingMsa.expiresAt > Date.now())
  if (msa) {
    banner.className = 'banner warn'
    banner.appendChild(el('div', '', `${sessionName(msa.id)} needs a Microsoft sign-in. Open the link and enter this code:`))
    banner.appendChild(el('div', 'code', msa.pendingMsa.code))
    const link = el('a', '', msa.pendingMsa.url)
    link.href = msa.pendingMsa.url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    banner.appendChild(link)
    return
  }
  if (store.ws && !store.connected) {
    banner.className = 'banner'
    banner.textContent = 'Lost the connection to golemlink. Reconnecting.'
  }
}

// --- textures ---------------------------------------------------------------
function syncTextures () {
  const version = store.session()?.version
  if (version && store.textures.includes(version) && texturesVersion() !== version) useTextures(version)
}

// --- keys ---------------------------------------------------------------------
function onKey (event) {
  if (event.key === 'Escape') {
    if (menuOpen()) closeMenu()
    else if (!document.getElementById('session-menu').classList.contains('hidden')) closeSessionMenu()
    else if (store.window && document.body.dataset.view === 'play') closeWindow()
    else return
    event.preventDefault()
    return
  }
  if (document.body.dataset.view !== 'play') return
  if (playKey(event)) event.preventDefault()
}

// --- wiring -------------------------------------------------------------------
let shellReady = false
function initShell () {
  if (shellReady) return
  shellReady = true
  initPlay()
  initChat()
  initMove()
  initSetup()

  for (const button of document.querySelectorAll('.rail-item[data-view], .p-tab[data-view]')) {
    button.addEventListener('click', () => setView(button.dataset.view))
  }
  document.getElementById('open-chat').addEventListener('click', () => setView('chat'))
  window.addEventListener('golemlink-view', event => setView(event.detail))
  window.addEventListener('hashchange', () => setView(location.hash.slice(1), { push: false }))
  DESKTOP.addEventListener('change', () => {
    if (document.body.dataset.view === 'chat') setView('play')
    onResize()
  })

  const picker = document.getElementById('session-picker')
  const menu = document.getElementById('session-menu')
  picker.addEventListener('click', () => {
    const open = menu.classList.toggle('hidden') === false
    picker.setAttribute('aria-expanded', String(open))
    if (open) renderSessionMenu()
  })
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target) && !picker.contains(event.target)) closeSessionMenu()
  })
  for (const id of ['sign-out', 'setup-sign-out']) {
    document.getElementById(id).addEventListener('click', async () => {
      releaseAllControls(true)
      disconnect()
      await signOut()
    })
  }
  document.addEventListener('keydown', onKey)

  const all = () => {
    renderTop()
    renderRail()
    renderBanner()
    renderUser()
    syncTextures()
  }
  store.on('hello', all)
  store.on('sessions', all)
  store.on('servers', renderTop)
  store.on('session', () => {
    all()
    renderRecent()
  })
  store.on('status', renderTop)
  store.on('snapshot', renderTop)
  store.on('connection', connected => {
    if (!connected) releaseAllControls(false)
    renderBanner()
  })
  store.on('msa', renderBanner)
  store.on('textures', syncTextures)
  store.on('signed-out', () => {
    releaseAllControls(false)
    checkLogin().then(me => me && start(me))
  })
  store.on('alert', alert => {
    showToast(alert.text, alert.kind)
    if (alert.kind === 'damage' && document.visibilityState === 'visible' && navigator.vibrate) {
      try { navigator.vibrate(100) } catch {}
    }
  })
  store.on('goto', msg => {
    if (msg.phase === 'failed') showToast(`Couldn’t walk there: ${msg.detail || 'no path'}`, 'error')
    else if (msg.phase === 'arrived') showToast('Arrived')
  })
  store.on('err', err => {
    if (err.code !== 'rate_limited') showToast(err.msg || err.code, 'error')
  })
  onChatChange(renderRecent)
  store.on('chat', line => {
    if (!line.echo && document.body.dataset.view !== 'chat' && !DESKTOP.matches) {
      document.getElementById('chat-tab').classList.add('unread')
    }
  })
  window.addEventListener('golemlink-toast', event => showToast(event.detail))

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseAllControls(true)
  })
  window.addEventListener('blur', () => releaseAllControls(true))
  window.addEventListener('pagehide', () => releaseAllControls(true))

  // Keeps "online for" and "reconnecting in" counting.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return
    renderRail()
    renderTop()
    if (!document.getElementById('session-menu').classList.contains('hidden')) renderSessionMenu()
  }, 1000)
}

function start (me) {
  store.me = me
  store.signedOut = false
  initShell()
  renderUser()
  connect()
}

function main () {
  setView(location.hash.slice(1) || 'play', { push: false })
  initLogin(start)
  checkLogin().then(me => me && start(me))
}

main()
