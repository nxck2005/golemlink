import { store } from './store.js'

let backoffMs = 1000
let reconnectTimer = null
let stopped = false

export function tokenFromUrl () {
  let token = null
  try {
    token = localStorage.getItem('golemlink.token')
  } catch {}
  if (location.hash.startsWith('#t=')) {
    try {
      token = decodeURIComponent(location.hash.slice(3))
    } catch {
      token = null
    }
    try {
      if (token) localStorage.setItem('golemlink.token', token)
    } catch {}
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {}
  }
  return token
}

export function connect () {
  const token = tokenFromUrl()
  if (!token) {
    store.emit('token-missing')
    return
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/`)
  store.ws = ws
  ws.addEventListener('open', () => {
    backoffMs = 1000
    ws.send(JSON.stringify({ t: 'auth', token }))
  })
  ws.addEventListener('message', event => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    handle(msg)
  })
  ws.addEventListener('close', event => {
    store.connected = false
    store.emit('connection', false)
    if (event.code === 4401) {
      store.tokenRejected = true
      store.emit('token-rejected')
      return
    }
    if (stopped) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoffMs)
    backoffMs = Math.min(10000, backoffMs * 2)
  })
  ws.addEventListener('error', () => {})
}

export function send (msg) {
  const ws = store.ws
  if (!ws || ws.readyState !== 1 || !store.connected) return false
  ws.send(JSON.stringify(msg))
  return true
}

export function subscribe (id = store.sessionId) {
  if (id) send({ t: 'sub', s: id })
}

function updateSession (state) {
  const session = store.sessions.find(s => s.id === state.s)
  if (session) {
    session.state = state.state
    session.reason = state.reason
    session.detail = state.detail
    if (state.retryInMs) session.retryInMs = state.retryInMs
    else delete session.retryInMs
    if (state.state !== 'connecting') delete session.pendingMsa
  }
  store.emit('sessions')
}

function handle (msg) {
  if (!msg || typeof msg !== 'object') return
  // A socket can be subscribed to several bots. Never apply another bot's
  // inventory, map or completion response to the selected session.
  const scoped = ['snapshot', 'status', 'chat', 'inv', 'window', 'tiles', 'untile', 'players', 'ctlReset', 'goto', 'tab']
  if (scoped.includes(msg.t) && msg.s !== store.sessionId) return
  switch (msg.t) {
    case 'hello': {
      store.hello = msg
      store.sessions = msg.sessions || []
      store.accounts = msg.accounts || []
      store.servers = msg.servers || []
      store.daemon = msg.daemon || null
      store.features = { ...store.features, ...(msg.features || {}) }
      store.connected = true
      store.tokenRejected = false
      if (!store.sessionId || !store.sessions.some(s => s.id === store.sessionId)) {
        store.setSession(store.sessions[0]?.id || null)
      }
      store.emit('connection', true)
      store.emit('hello')
      if (store.sessionId) subscribe(store.sessionId)
      break
    }
    case 'sessions':
      store.sessions = msg.sessions || []
      if (!store.sessionId || !store.sessions.some(s => s.id === store.sessionId)) {
        store.setSession(store.sessions[0]?.id || null)
        subscribe()
      }
      store.emit('sessions')
      break
    case 'state':
      updateSession(msg)
      break
    case 'snapshot':
      if (msg.s === store.sessionId) {
        store.snapshot = msg
        store.status = msg.status
        store.chat = (msg.chat || []).slice(-500)
        store.window = msg.window
        store.inventory = msg.inventory
        store.cursor = msg.cursor
        store.players = msg.players || []
        store.tiles.clear()
        if (msg.features) store.features = { ...store.features, ...msg.features }
        store.emit('snapshot')
      }
      break
    case 'status':
      if (msg.s === store.sessionId) {
        store.status = msg
        store.emit('status')
      }
      break
    case 'chat':
      if (msg.s === store.sessionId) {
        store.pushChat(msg)
        store.emit('chat', msg)
      }
      break
    case 'inv':
      if (msg.window === 0 && store.inventory) applyDelta(store.inventory, msg.slots)
      if (store.window && msg.window === store.window.id) applyDelta(store.window, msg.slots)
      if (msg.cursor !== undefined) store.cursor = msg.cursor
      store.emit('inv', msg)
      break
    case 'window':
      store.window = msg.window
      store.emit('window', msg.window)
      break
    case 'tiles':
      for (const tile of msg.tiles || []) store.tiles.set(`${tile.cx},${tile.cz}`, tile)
      store.emit('tiles', msg.tiles)
      break
    case 'untile':
      for (const tile of msg.tiles || []) store.tiles.delete(`${tile.cx},${tile.cz}`)
      store.emit('tiles', [])
      break
    case 'players':
      if (msg.s === store.sessionId) {
        store.players = msg.players || []
        store.emit('players')
      }
      break
    case 'ctlReset':
      if (msg.s === store.sessionId) store.emit('ctlReset', msg)
      break
    case 'goto':
      if (msg.s === store.sessionId) store.emit('goto', msg)
      break
    case 'alert':
      store.emit('alert', msg)
      break
    case 'msa': {
      const session = store.sessions.find(s => s.id === msg.s)
      if (session) {
        session.pendingMsa = { code: msg.code, url: msg.url, expiresAt: msg.expiresAt }
      }
      store.emit('msa', msg)
      break
    }
    case 'accounts':
      store.accounts = msg.accounts || []
      store.emit('accounts')
      break
    case 'servers':
      store.servers = msg.servers || []
      store.emit('servers')
      break
    case 'tab':
      store.emit('tab', msg)
      break
    case 'err':
      store.emit('err', msg)
      break
    default:
      break
  }
}

function applyDelta (windowState, slots) {
  if (!windowState || !windowState.slots || !slots) return
  for (const [key, item] of Object.entries(slots)) {
    const index = Number(key)
    if (Number.isInteger(index) && index >= 0 && index < windowState.slots.length) {
      windowState.slots[index] = item
    }
  }
}
