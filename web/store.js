// Shared client state. Every module imports this object; changes are
// announced through a tiny event emitter.
export const MAX_CHAT_ROWS = 500

const listeners = new Map()

export const store = {
  ws: null,
  connected: false,
  signedOut: false,
  me: null,
  hello: null,
  textures: [],
  sessions: [],
  accounts: [],
  servers: [],
  daemon: null,
  sessionId: null,
  snapshot: null,
  status: null,
  players: [],
  board: null, // { sidebar, bars, tab }
  chat: [],
  window: null,
  inventory: null,
  cursor: null,
  tiles: new Map(), // "cx,cz" -> {cx,cz,rgb}
  features: {
    goto: false,
    clickModes: ['normal'],
    tabComplete: false,
    notifications: false,
    wakeLock: false
  },

  on (event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    return () => listeners.get(event)?.delete(fn)
  },

  emit (event, data) {
    for (const fn of listeners.get(event) || []) {
      try {
        fn(data)
      } catch (err) {
        console.error('ui handler failed', event, err)
      }
    }
  },

  // Session list entries carry relative times; turn them into local clock
  // times once, when they arrive.
  stampSession (session, receivedAt = Date.now()) {
    if (session.onlineMs != null) session.onlineAt = receivedAt - session.onlineMs
    else if (session.state !== 'online') session.onlineAt = null
    if (session.retryInMs) session.retryAt = receivedAt + session.retryInMs
    else if (session.state !== 'reconnecting') session.retryAt = null
    return session
  },

  session () {
    return this.sessions.find(s => s.id === this.sessionId) || null
  },

  setSession (id) {
    if (this.sessionId === id) return
    this.sessionId = id
    try {
      localStorage.setItem('golemlink.session', id || '')
    } catch {}
    this.snapshot = null
    this.status = null
    this.chat = []
    this.window = null
    this.inventory = null
    this.cursor = null
    this.players = []
    this.board = null
    this.tiles.clear()
    this.emit('session', id)
  },

  restoreSession () {
    try {
      const saved = localStorage.getItem('golemlink.session')
      if (saved) this.sessionId = saved
    } catch {}
  },

  pushChat (line) {
    this.chat.push(line)
    if (this.chat.length > MAX_CHAT_ROWS) this.chat.splice(0, this.chat.length - MAX_CHAT_ROWS)
  }
}

store.restoreSession()
