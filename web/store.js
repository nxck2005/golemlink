// Shared client state. Every module imports this object; changes are
// announced through a tiny event emitter.
export const MAX_CHAT_ROWS = 500

const listeners = new Map()

export const store = {
  ws: null,
  connected: false,
  tokenRejected: false,
  hello: null,
  sessions: [],
  accounts: [],
  servers: [],
  daemon: null,
  sessionId: null,
  snapshot: null,
  status: null,
  players: [],
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
