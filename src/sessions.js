import { Session, SUPPORTED_VERSIONS } from './session.js'

const MAX_SESSIONS = 8

function fail (code, msg) {
  return Object.assign(new Error(msg), { code })
}

export class Sessions {
  constructor ({ getConfig, dataDir, logger, termux, hub }) {
    this.getConfig = getConfig
    this.dataDir = dataDir
    this.logger = logger
    this.termux = termux
    this.hub = hub
    this.sessions = new Map()
    this.authChains = new Map()
  }

  get supportedVersions () {
    return SUPPORTED_VERSIONS
  }

  get (id) {
    return this.sessions.get(id) || null
  }

  list () {
    return [...this.sessions.values()].map(session => session.info())
  }

  activeCount () {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.state !== 'stopped') count++
    }
    return count
  }

  start (accountId, serverId) {
    const config = this.getConfig()
    const account = config.accounts.find(a => a.id === accountId)
    if (!account) throw fail('no_account', `unknown account "${accountId}"`)
    const server = config.servers.find(s => s.id === serverId)
    if (!server) throw fail('no_server', `unknown server "${serverId}"`)
    const id = `${accountId}@${serverId}`
    const existing = this.sessions.get(id)
    if (existing && existing.state !== 'stopped') throw fail('already_running', `session ${id} is ${existing.state}`)
    if (existing) {
      existing.destroy()
      this.sessions.delete(id)
    }
    if (this.activeCount() >= MAX_SESSIONS) throw fail('session_limit', `at most ${MAX_SESSIONS} sessions can run at once`)
    const session = new Session({
      account,
      server,
      config,
      dataDir: this.dataDir,
      logger: this.logger,
      termux: this.termux,
      hub: this.hub,
      manager: this
    })
    this.sessions.set(id, session)
    session.start()
    this.notifySessionsChanged()
    return session
  }

  stop (id) {
    const session = this.sessions.get(id)
    if (!session) throw fail('no_session', `unknown session "${id}"`)
    session.stop()
    this.notifySessionsChanged()
  }

  startAutostart () {
    const config = this.getConfig()
    for (const entry of config.autostart || []) {
      const [accountId, serverId] = entry.split('@')
      try {
        this.start(accountId, serverId)
      } catch (err) {
        this.logger.warn(`autostart ${entry} failed: ${err.message}`)
      }
    }
  }

  async handle (msg, clientId) {
    if (msg.t === 'session.start') {
      this.start(msg.account, msg.server)
      return null
    }
    if (msg.t === 'session.stop') {
      this.stop(msg.s)
      return null
    }
    const session = this.sessions.get(msg.s)
    if (!session) throw fail('no_session', `unknown session "${msg.s}"`)
    return session.handle(msg, clientId)
  }

  // Only one session per account signs in at a time: prismarine-auth keeps a
  // per-flow in-memory cache and rewrites whole cache files.
  acquireAuth (accountId) {
    const previous = this.authChains.get(accountId) || Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    this.authChains.set(accountId, gate)
    const releaseOnce = () => {
      release()
      if (this.authChains.get(accountId) === gate) this.authChains.delete(accountId)
    }
    return previous.then(() => releaseOnce)
  }

  notifySessionsChanged () {
    try {
      this.hub.broadcast({ t: 'sessions', sessions: this.list() })
    } catch {}
  }

  // Called after config changes: stop sessions whose account/server vanished,
  // push new server settings into live sessions.
  reconcile () {
    const config = this.getConfig()
    for (const [id, session] of [...this.sessions.entries()]) {
      const account = config.accounts.find(a => a.id === session.account.id)
      const server = config.servers.find(s => s.id === session.server.id)
      if (!account || !server) {
        session.destroy()
        this.sessions.delete(id)
        continue
      }
      session.account = account
      session.chatLog.setPasswords(server.autoLogin?.password ? [server.autoLogin.password] : [])
      session.updateServer(server)
    }
    this.notifySessionsChanged()
  }

  stopAll () {
    for (const session of this.sessions.values()) {
      try {
        session.stop('shutdown')
      } catch {}
    }
  }

  destroyAll () {
    for (const session of this.sessions.values()) {
      try {
        session.destroy()
      } catch {}
    }
    this.sessions.clear()
  }
}
