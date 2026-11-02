import { WebSocketServer } from 'ws'
import { validateClientMessage, MAX_CLIENT_FRAME } from './protocol.js'
import { cookieToken, clientIp } from './api.js'

const RATE_PER_SECOND = 60
const RATE_BURST = 120
const FLOOD_WINDOW_MS = 5000
const FLOOD_LIMIT = 600
const BACKPRESSURE_HIGH = 1024 * 1024
const BACKPRESSURE_LOW = 256 * 1024

export class WsHub {
  constructor ({ server, access, auth, sessions, logger, control, termux, textures }) {
    this.servers = server ? [server] : []
    this.access = access
    this.auth = auth
    this.sessions = sessions
    this.logger = logger
    this.control = control
    this.termux = termux
    this.textures = textures
    this.clients = new Set()
    this.nextClientId = 1
    this.wss = null
    this.drainTimer = null
  }

  attach () {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME })
    for (const server of this.servers) this.attachServer(server)
    this.wss.on('connection', (ws, req, login) => this.onConnection(ws, login))
    this.drainTimer = setInterval(() => this.checkBackpressure(), 1000)
    this.drainTimer.unref?.()
  }

  attachServer (server) {
    if (!this.servers.includes(server)) this.servers.push(server)
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
  }

  destroy () {
    clearInterval(this.drainTimer)
    for (const client of this.clients) {
      try {
        client.ws.terminate()
      } catch {}
    }
    this.clients.clear()
    this.wss?.close()
  }

  handleUpgrade (req, socket, head) {
    const origin = req.headers.origin
    const host = req.headers.host
    const reject = (reason, log) => {
      // Complete the handshake so the browser sees close code 4401 rather
      // than an opaque network error.
      this.wss.handleUpgrade(req, socket, head, ws => ws.close(4401, reason))
      if (log) this.logger.warn(log)
    }
    if (!this.access.originAllowed(origin) || !this.access.hostAllowed(host)) {
      reject('forbidden origin or host', `ws upgrade rejected (origin=${origin || '-'} host=${host || '-'})`)
      return
    }
    const login = this.auth.verify(cookieToken(req), { ip: clientIp(req) })
    if (!login) {
      reject('sign in required')
      return
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req, login))
  }

  onConnection (ws, login) {
    const client = {
      id: this.nextClientId++,
      ws,
      loginId: login.id,
      authed: true,
      subscriptions: new Set(),
      tokens: RATE_BURST,
      lastRefill: Date.now(),
      flood: [],
      paused: false,
      closed: false
    }
    this.clients.add(client)
    ws.on('message', data => {
      try {
        this.onMessage(client, data)
      } catch (err) {
        this.logger.error(`ws handler threw: ${err?.stack || err}`)
        this.sendErr(client, undefined, 'internal', 'internal error')
      }
    })
    ws.on('close', () => this.onClose(client))
    ws.on('error', () => {})
    this.send(client, this.hello())
  }

  // Disconnects every socket opened with a login that was just signed out.
  closeLogin (loginId) {
    for (const client of this.clients) {
      if (client.loginId === loginId) this.close(client, 4401, 'signed out')
    }
  }

  onMessage (client, data) {
    if (client.closed) return
    const now = Date.now()
    const refill = ((now - client.lastRefill) / 1000) * RATE_PER_SECOND
    client.lastRefill = now
    client.tokens = Math.min(RATE_BURST, client.tokens + refill)
    client.flood = client.flood.filter(t => now - t < FLOOD_WINDOW_MS)
    client.flood.push(now)
    if (client.flood.length > FLOOD_LIMIT) {
      this.close(client, 1008, 'flooding')
      return
    }
    if (client.tokens < 1) {
      let id
      try {
        id = JSON.parse(data.toString()).id
      } catch {}
      this.sendErr(client, id, 'rate_limited', 'too many messages')
      return
    }
    client.tokens -= 1

    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      this.sendErr(client, undefined, 'bad_json', 'message is not valid JSON')
      return
    }
    this.handleMessage(client, msg)
  }

  hello () {
    return {
      t: 'hello',
      v: 1,
      sessions: this.sessions.list(),
      accounts: this.control.accountsForUi(),
      servers: this.control.serversForUi(),
      supportedVersions: [...(this.sessions?.supportedVersions || [])],
      features: {
        goto: true,
        clickModes: ['normal', 'shift'],
        tabComplete: true,
        notifications: Boolean(this.termux?.available?.notifications),
        wakeLock: Boolean(this.termux?.available?.wakeLock)
      },
      daemon: this.control.daemonInfo(),
      user: this.auth?.username?.() || null,
      textures: this.textures ? this.textures.ready() : []
    }
  }

  async handleMessage (client, msg) {
    const result = validateClientMessage(msg)
    if (!result.ok) {
      this.sendErr(client, msg.id, result.code, result.msg)
      return
    }
    const value = result.value
    try {
      switch (value.t) {
        case 'sub': {
          const session = this.sessions.get(value.s)
          if (!session) throw Object.assign(new Error(`unknown session "${value.s}"`), { code: 'no_session' })
          client.subscriptions.add(value.s)
          this.send(client, session.snapshot())
          for (const tiles of session.tileBatches()) this.send(client, { t: 'tiles', s: value.s, tiles })
          session.onSubscribed()
          break
        }
        case 'session.start':
          this.control.startSession(value.account, value.server)
          break
        case 'session.stop':
          this.control.stopSession(value.s)
          break
        case 'config.server.put': {
          this.control.putServer(value.server)
          this.broadcastConfig()
          break
        }
        case 'config.server.del': {
          this.control.delServer(value.id)
          this.broadcastConfig()
          break
        }
        case 'config.account.put': {
          this.control.putAccount(value.account)
          this.broadcastConfig()
          break
        }
        case 'config.account.del': {
          this.control.delAccount(value.id)
          this.broadcastConfig()
          break
        }
        default: {
          const response = await this.sessions.handle(value, client.id)
          if (response && response.t === 'tab') this.send(client, { ...response, s: value.s })
          break
        }
      }
      if (msg.id !== undefined) this.send(client, { t: 'ack', id: msg.id })
    } catch (err) {
      this.sendErr(client, msg.id, err.code || 'error', err.message || String(err))
    }
  }

  broadcastConfig () {
    this.broadcast({ t: 'accounts', accounts: this.control.accountsForUi() })
    this.broadcast({ t: 'servers', servers: this.control.serversForUi() })
  }

  clearSubscriptions (client) {
    for (const sid of client.subscriptions) {
      const session = this.sessions.get(sid)
      session?.movement?.releaseLease(client.id)
    }
    client.subscriptions.clear()
  }

  onClose (client) {
    if (client.closed) return
    client.closed = true
    this.clearSubscriptions(client)
    this.clients.delete(client)
  }

  send (client, msg) {
    if (client.closed || client.ws.readyState !== 1) return false
    try {
      client.ws.send(JSON.stringify(msg))
      return true
    } catch (err) {
      this.logger.warn(`ws send failed: ${err.message}`)
      return false
    }
  }

  sendVolatile (client, msg) {
    if (client.paused) return
    if (client.ws.bufferedAmount > BACKPRESSURE_HIGH) {
      client.paused = true
      return
    }
    this.send(client, msg)
  }

  sendErr (client, id, code, message) {
    const msg = { t: 'err', code, msg: String(message ?? '') }
    if (id !== undefined) msg.id = id
    this.send(client, msg)
  }

  close (client, code, reason) {
    try {
      client.ws.close(code, reason)
    } catch {}
  }

  broadcast (msg) {
    for (const client of this.clients) {
      if (client.authed) this.send(client, msg)
    }
  }

  sendToSubscribers (sid, msg) {
    const volatile = msg.t === 'status' || msg.t === 'tiles'
    for (const client of this.clients) {
      if (!client.authed || !client.subscriptions.has(sid)) continue
      if (volatile) this.sendVolatile(client, msg)
      else this.send(client, msg)
    }
  }

  subscriberCount (sid) {
    let count = 0
    for (const client of this.clients) {
      if (client.authed && client.subscriptions.has(sid)) count++
    }
    return count
  }

  checkBackpressure () {
    for (const client of this.clients) {
      if (!client.paused) continue
      if (client.ws.bufferedAmount > BACKPRESSURE_LOW) continue
      client.paused = false
      for (const sid of client.subscriptions) {
        const session = this.sessions.get(sid)
        if (session) this.send(client, session.snapshot())
      }
    }
  }
}
