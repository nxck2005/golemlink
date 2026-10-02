import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { validateClientMessage, MAX_CLIENT_FRAME } from './protocol.js'
import { sanitizeAccount, sanitizeServer } from './config.js'

const AUTH_TIMEOUT_MS = 5000
const RATE_PER_SECOND = 60
const RATE_BURST = 120
const FLOOD_WINDOW_MS = 5000
const FLOOD_LIMIT = 600
const BACKPRESSURE_HIGH = 1024 * 1024
const BACKPRESSURE_LOW = 256 * 1024

export class WsHub {
  constructor ({ server, host, port, unsafeBind, token, sessions, logger, control, termux, authTimeoutMs }) {
    this.server = server
    this.host = host
    this.port = port
    this.unsafeBind = unsafeBind
    this.authTimeoutMs = authTimeoutMs || AUTH_TIMEOUT_MS
    this.tokenDigest = crypto.createHash('sha256').update(token).digest()
    this.sessions = sessions
    this.logger = logger
    this.control = control
    this.termux = termux
    this.clients = new Set()
    this.nextClientId = 1
    this.wss = null
    this.drainTimer = null
  }

  allowedOrigins () {
    const origins = new Set([
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`
    ])
    if (this.unsafeBind) origins.add(`http://${this.unsafeBind}:${this.port}`)
    return origins
  }

  allowedHosts () {
    const hosts = new Set([
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`
    ])
    if (this.unsafeBind) hosts.add(`${this.unsafeBind}:${this.port}`)
    return hosts
  }

  attach () {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME })
    this.origins = this.allowedOrigins()
    this.hosts = this.allowedHosts()
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
    this.wss.on('connection', ws => this.onConnection(ws))
    this.drainTimer = setInterval(() => this.checkBackpressure(), 1000)
    this.drainTimer.unref?.()
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
    const originOk = this.origins.has(origin)
    const hostOk = this.hosts.has(host)
    if (!originOk || !hostOk) {
      // Complete the handshake so the browser sees close code 4401 rather
      // than an opaque network error.
      this.wss.handleUpgrade(req, socket, head, ws => {
        ws.close(4401, 'forbidden origin or host')
      })
      this.logger.warn(`ws upgrade rejected (origin=${origin || '-'} host=${host || '-'})`)
      return
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req))
  }

  onConnection (ws) {
    const client = {
      id: this.nextClientId++,
      ws,
      authed: false,
      subscriptions: new Set(),
      tokens: RATE_BURST,
      lastRefill: Date.now(),
      flood: [],
      paused: false,
      closed: false,
      authTimer: null
    }
    this.clients.add(client)
    client.authTimer = setTimeout(() => {
      if (!client.authed) this.close(client, 4401, 'auth timeout')
    }, this.authTimeoutMs)
    client.authTimer.unref?.()

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

    if (!client.authed) {
      this.handleAuth(client, msg)
      return
    }
    this.handleMessage(client, msg)
  }

  handleAuth (client, msg) {
    if (msg?.t !== 'auth' || typeof msg.token !== 'string') {
      this.sendErr(client, msg?.id, 'auth_required', 'first message must be an auth message')
      this.close(client, 4401, 'auth required')
      return
    }
    const digest = crypto.createHash('sha256').update(msg.token).digest()
    let valid = false
    try {
      valid = crypto.timingSafeEqual(digest, this.tokenDigest)
    } catch {
      valid = false
    }
    if (!valid) {
      this.sendErr(client, msg.id, 'bad_token', 'token rejected')
      this.close(client, 4401, 'bad token')
      return
    }
    client.authed = true
    clearTimeout(client.authTimer)
    this.send(client, this.hello())
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
      daemon: this.control.daemonInfo()
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
    clearTimeout(client.authTimer)
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
