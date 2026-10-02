import path from 'node:path'
import { createRequire } from 'node:module'
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { Movement, pathfinderAvailable } from './movement.js'
import { InventoryMirror } from './inventory.js'
import { Minimap } from './minimap.js'
import { ChatLog, validateChatText, createRateLimiter, componentToPlain } from './chat.js'
import { normalizeComponentText } from './protocol.js'
import { Alerts } from './alerts.js'
import { compileTrigger } from './config.js'

const require = createRequire(import.meta.url)
const versionInfo = require('mineflayer/lib/version.js')
export const SUPPORTED_VERSIONS = versionInfo.testedVersions
export const LATEST_SUPPORTED = versionInfo.latestSupportedVersion
export const OLDEST_SUPPORTED = versionInfo.oldestSupportedVersion

export function supportedRange () {
  return `${OLDEST_SUPPORTED} – ${LATEST_SUPPORTED}`
}

const NO_SPAWN_MS = 30 * 1000
const KICK_WINDOW_MS = 30 * 60 * 1000
const KICK_LIMIT = 3

function classifyText (hay) {
  if (/multiplayer\.disconnect\.duplicate_login|velocity\.error\.already-connected|already-connected-(proxy|server)|logged in from another location|already connected to this proxy|already connected to this server/i.test(hay)) return 'duplicate_login'
  if (/multiplayer\.disconnect\.idling|\b(afk|idle|idling|inactiv\w*)\b/i.test(hay)) return 'idle'
  if (/multiplayer\.disconnect\.banned|banned-ip|you are banned|you have been banned/i.test(hay)) return 'banned'
  if (/whitelist/i.test(hay)) return 'not_whitelisted'
  if (/outdated_client|outdated_server|multiplayer\.disconnect\.incompatible|outdated client|outdated server|incompatible client|unsupported protocol version|no data available for version|is not supported|please specify the correct version|server is version/i.test(hay)) return 'version'
  if (/neoforge|forge|fml|modded/i.test(hay)) return 'modded'
  if (/failed to verify username|failed to authenticate|authentication failed|invalid credentials|failed to log in|unable to authenticate|failed to obtain profile/i.test(hay)) return 'auth'
  if (/multiplayer\.disconnect\.server_shutdown|server closed|proxy shutting down|restart/i.test(hay)) return 'shutdown'
  return null
}

export class Session {
  constructor ({ account, server, config, dataDir, logger, termux, hub, manager, noSpawnMs }) {
    this.account = account
    this.server = server
    this.config = config
    this.dataDir = dataDir
    this.logger = logger
    this.termux = termux
    this.hub = hub
    this.manager = manager
    this.noSpawnMs = noSpawnMs || NO_SPAWN_MS
    this.id = `${account.id}@${server.id}`
    this.state = 'stopped'
    this.reason = null
    this.detail = null
    this.retryInMs = 0
    this.pendingMsa = null
    this.bot = null
    this.attemptSettled = true
    this.manualStop = true
    this.backoffMs = 0
    this.kickTimes = []
    this.releaseAuth = null
    this.movement = null
    this.inventory = null
    this.minimap = null
    this.statusTimer = null
    this.playersTimer = null
    this.actionbar = null
    this.lastTarget = null
    this.lastTargetAt = 0
    this.autoLogin = null
    this.sentTexts = new Map()
    this.chatLog = new ChatLog({
      sessionId: this.id,
      dataDir,
      chatLog: server.chatLog,
      registry: null,
      logger
    })
    this.chatLog.setPasswords(server.autoLogin?.password ? [server.autoLogin.password] : [])
    this.tabLimiter = createRateLimiter({ rate: 4, burst: 4 })
    this.alerts = new Alerts({
      sessionId: this.id,
      serverId: server.id,
      server,
      termux,
      logger,
      broadcast: msg => hub.broadcast(msg)
    })
  }

  info () {
    return {
      id: this.id,
      account: this.account.id,
      server: this.server.id,
      state: this.state,
      reason: this.reason,
      detail: this.detail,
      pendingMsa: this.pendingMsa
    }
  }

  updateServer (server) {
    this.server = server
    this.chatLog.fileLog = server.chatLog !== false
    this.chatLog.setPasswords(server.autoLogin?.password ? [server.autoLogin.password] : [])
    this.alerts.configure(server)
    this.movement?.setAntiAfk(server.antiAfk?.enabled === true && this.state === 'online', server.antiAfk?.intervalSec || 90)
  }

  // --- lifecycle --------------------------------------------------------
  start () {
    if (this.state !== 'stopped') return false
    this.manualStop = false
    this.backoffMs = 0
    this.attempt()
    return true
  }

  stop (reason = 'stopped') {
    this.manualStop = true
    this.pendingMsa = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.bot) {
      this.settle('stop', reason)
    } else {
      this.setState('stopped', { reason, detail: null })
    }
  }

  async attempt () {
    if (this.manualStop || this.bot || this.state === 'online') return
    this.setState('connecting', { reason: this.reason, detail: null })
    let release
    try {
      release = await this.manager.acquireAuth(this.account.id)
    } catch {
      release = () => {}
    }
    if (this.manualStop) {
      release?.()
      return
    }
    this.releaseAuth = release
    let bot
    try {
      bot = mineflayer.createBot({ ...this.botOptions(), plugins: { pathfinder: pf.pathfinder } })
    } catch (err) {
      // The pathfinder can fail to load on exotic versions; carry on without
      // it and disable features.goto (spec §8.4 fallback).
      this.logger.warn(`session ${this.id}: pathfinder failed to load (${err.message}); continuing without goto`)
      try {
        bot = mineflayer.createBot(this.botOptions())
      } catch (err2) {
        this.releaseAuthLock()
        this.applyOutcome(this.classify('error', err2, null))
        return
      }
    }
    this.bot = bot
    this.attemptSettled = false
    this.wrapEmits(bot)
    bot.on('error', err => this.settle('error', err))
    bot.on('kicked', reason => this.settle('kicked', reason))
    bot.on('end', reason => this.settle('end', reason))
    bot.on('connect', () => {
      if (this.bot === bot) this.armNoSpawnTimer()
    })
    bot.once('spawn', () => this.handleSpawn(bot))
    this.armNoSpawnTimer()
  }

  botOptions () {
    const version = this.server.version && this.server.version !== 'auto' ? this.server.version : false
    return {
      host: this.server.host,
      port: this.server.port || 25565,
      username: this.account.username,
      auth: this.account.auth === 'microsoft' ? 'microsoft' : 'offline',
      version,
      profilesFolder: path.join(this.dataDir, 'auth'),
      viewDistance: 6,
      hideErrors: true,
      checkTimeoutInterval: 30000,
      onMsaCode: code => this.handleMsaCode(code)
    }
  }

  wrapEmits (bot) {
    const clientEmit = bot._client.emit.bind(bot._client)
    const botEmit = bot.emit.bind(bot)
    bot._client.emit = (event, ...args) => {
      try {
        return clientEmit(event, ...args)
      } catch (err) {
        this.failInternal(bot, err, `client emit ${event}`)
      }
    }
    bot.emit = (event, ...args) => {
      try {
        return botEmit(event, ...args)
      } catch (err) {
        this.failInternal(bot, err, `bot emit ${event}`)
      }
    }
  }

  failInternal (bot, err, source) {
    if (this.bot !== bot || this.attemptSettled) return
    this.logger.error(`session ${this.id}: ${source} threw: ${err?.stack || err?.message || err}`)
    this.settle('internal', err)
  }

  armNoSpawnTimer () {
    if (this.noSpawnTimer) clearTimeout(this.noSpawnTimer)
    this.noSpawnTimer = setTimeout(() => {
      this.settle('error', new Error('timed out after 30 s without spawning'))
    }, this.noSpawnMs)
    this.noSpawnTimer.unref?.()
  }

  clearAttemptTimers () {
    if (this.noSpawnTimer) clearTimeout(this.noSpawnTimer)
    this.noSpawnTimer = null
    if (this.msaExpiryTimer) clearTimeout(this.msaExpiryTimer)
    this.msaExpiryTimer = null
  }

  releaseAuthLock () {
    if (this.releaseAuth) {
      try {
        this.releaseAuth()
      } catch {}
      this.releaseAuth = null
    }
  }

  settle (kind, data) {
    if (!this.bot || this.attemptSettled) return
    this.attemptSettled = true
    const bot = this.bot
    this.bot = null
    this.clearAttemptTimers()
    this.releaseAuthLock()
    this.teardownModules()
    try {
      bot.end?.(`golemlink ${kind}`)
    } catch {}
    // Give mineflayer's own 'end' cleanup a chance to run (it clears the
    // physics interval), then drop every listener. Events emitted in the
    // meantime are ignored because this.bot is already null.
    const cleanup = setTimeout(() => {
      try {
        bot.removeAllListeners()
        bot._client?.removeAllListeners()
      } catch {}
    }, 250)
    cleanup.unref?.()
    const outcome = this.classify(kind, data, bot)
    this.applyOutcome(outcome)
  }

  teardownModules () {
    if (this.movement) {
      this.movement.destroy()
      this.movement = null
    }
    if (this.inventory) {
      this.inventory.detach()
      this.inventory = null
    }
    if (this.minimap) {
      this.minimap.destroy()
      this.minimap = null
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
    if (this.playersTimer) {
      clearInterval(this.playersTimer)
      this.playersTimer = null
    }
  }

  classify (kind, data, bot) {
    const registry = bot?.registry || this.lastRegistry || null
    const normalized = this.normalizeReason(data, registry)
    const plain = normalized.plain || ''
    const translate = normalized.translate || ''
    const hay = `${translate} ${plain}`.trim()

    if (kind === 'stop') return { action: 'stop', reason: typeof data === 'string' ? data : 'stopped', detail: null }

    const type = classifyText(hay)
    if (type === 'duplicate_login' || type === 'idle' || type === 'banned' || type === 'not_whitelisted' || type === 'modded' || type === 'auth') {
      return { action: 'stop', reason: type, detail: plain || translate || null }
    }
    if (type === 'version') {
      const reported = /(?:protocol version|server is version|version)\s*['"]?([0-9][\w.]*)/i.exec(plain || translate)
      const detail = [
        plain || translate,
        `server version: ${reported ? reported[1] : 'unknown (see the message above)'}`,
        `golemlink supports ${supportedRange()}`,
        'pin a supported version in the server config, or run ViaVersion + ViaBackwards on servers you control'
      ].filter(Boolean).join(' — ')
      return { action: 'stop', reason: 'version', detail }
    }
    if (kind === 'internal') {
      return { action: 'reconnect', reason: 'internal', detail: plain || String(data?.message || data), kick: true }
    }
    if (type === 'shutdown' || kind === 'error' || kind === 'end') {
      return { action: 'reconnect', reason: type === 'shutdown' ? 'shutdown' : (kind === 'error' ? 'network' : 'disconnected'), detail: plain || null, kick: false }
    }
    if (kind === 'kicked') {
      return { action: 'reconnect', reason: 'kicked', detail: plain || translate || 'unknown kick reason', kick: true }
    }
    return { action: 'reconnect', reason: 'disconnected', detail: plain || null, kick: false }
  }

  normalizeReason (data, registry) {
    if (data instanceof Error) {
      return { plain: data.message || String(data), translate: data.code }
    }
    const toPlain = raw => {
      try {
        return componentToPlain(raw, registry)
      } catch {
        return null
      }
    }
    return normalizeComponentText(data, toPlain)
  }

  registerKick () {
    const now = Date.now()
    this.kickTimes = this.kickTimes.filter(t => now - t < KICK_WINDOW_MS)
    this.kickTimes.push(now)
    return this.kickTimes.length >= KICK_LIMIT
  }

  applyOutcome ({ action, reason, detail, kick }) {
    this.pendingMsa = null
    if (action === 'stop') {
      this.setState('stopped', { reason, detail })
      this.alerts.stopped(reason, detail)
      this.logger.warn(`session ${this.id} stopped: ${reason}${detail ? ` (${detail})` : ''}`)
      return
    }
    if (!this.server.autoReconnect) {
      this.setState('stopped', { reason: `${reason} (auto-reconnect off)`, detail })
      return
    }
    if (kick && this.registerKick()) {
      const stopReason = 'kick_loop'
      this.setState('stopped', { reason: stopReason, detail: `kicked ${KICK_LIMIT} times within 30 minutes; use Stop, then Start to retry` })
      this.alerts.stopped(stopReason, detail)
      return
    }
    this.backoffMs = this.backoffMs === 0 ? 5000 : Math.min(5 * 60 * 1000, this.backoffMs * 2)
    const delay = Math.round(this.backoffMs * (0.8 + Math.random() * 0.4))
    this.setState('reconnecting', { reason, detail, retryInMs: delay })
    this.logger.info(`session ${this.id} reconnecting in ${delay} ms (${reason}${detail ? `: ${detail}` : ''})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.attempt()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  setState (state, { reason = null, detail = null, retryInMs = null } = {}) {
    this.state = state
    this.reason = reason
    this.detail = detail
    this.retryInMs = retryInMs || 0
    const msg = { t: 'state', s: this.id, state, reason, detail }
    if (retryInMs) msg.retryInMs = retryInMs
    this.hub.sendToSubscribers(this.id, msg)
    this.manager.notifySessionsChanged()
  }

  // --- login / spawn ----------------------------------------------------
  handleMsaCode (code) {
    if (this.noSpawnTimer) clearTimeout(this.noSpawnTimer)
    this.noSpawnTimer = null
    const userCode = code?.userCode || code?.user_code || String(code?.message || 'unknown code')
    const url = code?.verificationUri || code?.verification_uri || 'https://microsoft.com/link'
    const expiresIn = Number(code?.expiresIn || code?.expires_in || 900)
    this.pendingMsa = {
      code: userCode,
      url,
      expiresAt: Date.now() + expiresIn * 1000
    }
    this.hub.broadcast({ t: 'msa', s: this.id, ...this.pendingMsa })
    this.logger.info(`session ${this.id}: Microsoft sign-in code ${userCode} at ${url}`)
    this.alerts.msa(userCode, url)
    if (this.msaExpiryTimer) clearTimeout(this.msaExpiryTimer)
    this.msaExpiryTimer = setTimeout(() => {
      this.pendingMsa = null
    }, Math.max(1000, expiresIn * 1000))
    this.msaExpiryTimer.unref?.()
  }

  handleSpawn (bot) {
    if (this.bot !== bot) return
    this.pendingMsa = null
    this.releaseAuthLock()
    if (this.onlineResetTimer) clearTimeout(this.onlineResetTimer)
    this.onlineResetTimer = setTimeout(() => {
      this.backoffMs = 0
      this.kickTimes = []
    }, 60 * 1000)
    this.onlineResetTimer.unref?.()

    this.lastRegistry = bot.registry
    this.chatLog.registry = bot.registry
    this.alerts.botUsername = bot.username
    this.sentTexts.clear()
    this.actionbar = null

    this.inventory = new InventoryMirror({
      bot,
      registry: bot.registry,
      logger: this.logger,
      sessionId: this.id,
      sendToSubscribers: msg => this.sendToSubscribers(msg)
    })
    this.inventory.attach()

    this.movement = new Movement({
      bot,
      deadmanMs: this.config.deadmanMs,
      logger: this.logger,
      gotoAvailable: this.gotoAvailable(),
      onCtlReset: reason => this.sendToSubscribers({ t: 'ctlReset', s: this.id, reason }),
      onGoto: event => this.sendToSubscribers({ t: 'goto', s: this.id, phase: event.phase, detail: event.detail })
    })
    this.movement.setAntiAfk(this.server.antiAfk?.enabled === true, this.server.antiAfk?.intervalSec || 90)

    this.minimap = new Minimap({
      bot,
      registry: bot.registry,
      radiusChunks: this.config.minimap?.radiusChunks || 6,
      logger: this.logger,
      isWanted: () => this.hub.subscriberCount(this.id) > 0,
      onTiles: tiles => this.sendToSubscribers({ t: 'tiles', s: this.id, tiles }),
      onUntile: tiles => this.sendToSubscribers({ t: 'untile', s: this.id, tiles })
    })
    this.minimap.start()

    bot.on('message', (message, position, sender) => this.handleMessage(message, position, sender))
    bot.on('actionBar', message => {
      try {
        this.actionbar = componentToPlain(message, bot.registry)
      } catch {}
    })
    bot.on('health', () => {
      this.alerts.damage(this.lastHealth, bot.health)
      this.lastHealth = bot.health
    })
    bot.on('death', () => this.alerts.death())
    bot.on('resourcePack', (url, uuid) => this.handleResourcePack(bot, url, uuid))
    bot.on('playerJoined', () => this.sendPlayers())
    bot.on('playerLeft', () => this.sendPlayers())

    this.autoLogin = this.server.autoLogin
      ? { trigger: this.compileAutoLogin(this.server.autoLogin.trigger), sent: false, password: this.server.autoLogin.password }
      : null
    this.lastHealth = bot.health
    this.statusTimer = setInterval(() => this.sendStatus(), 200)
    this.statusTimer.unref?.()
    this.playersTimer = setInterval(() => this.sendPlayers(), 500)
    this.playersTimer.unref?.()

    this.setState('online', { reason: null, detail: null })
    this.sendPlayers()
  }

  compileAutoLogin (trigger) {
    try {
      return compileTrigger(trigger)
    } catch {
      return null
    }
  }

  gotoAvailable () {
    return pathfinderAvailable(this.bot)
  }

  handleResourcePack (bot, url, uuid) {
    const accept = this.server.resourcePack !== 'deny'
    try {
      const promise = accept ? bot.acceptResourcePack() : bot.denyResourcePack()
      Promise.resolve(promise).catch(err => this.logger.warn(`resource pack answer failed: ${err.message}`))
    } catch (err) {
      this.logger.warn(`resource pack answer failed: ${err.message}`)
    }
  }

  handleMessage (message, position, sender) {
    if (position === 'game_info') return
    const bot = this.bot
    if (!bot) return
    const line = this.chatLog.add(message, position, sender)
    const senderName = typeof sender === 'string' ? sender : sender?.name || null
    if (position === 'chat' && senderName === bot.username && this.isEcho(line.plain)) {
      return
    }
    this.sendToSubscribers({ t: 'chat', s: this.id, ts: line.ts, plain: line.plain, segs: line.segs })
    this.alerts.chat(line, senderName)
    if (this.autoLogin && !this.autoLogin.sent && this.autoLogin.trigger && this.autoLogin.trigger.test(line.plain)) {
      this.autoLogin.sent = true
      try {
        this.sendChat(`/login ${this.autoLogin.password}`)
      } catch (err) {
        this.logger.warn(`auto-login failed: ${err.message}`)
      }
    }
  }

  isEcho (plain) {
    const now = Date.now()
    for (const [text, ts] of this.sentTexts) {
      if (now - ts > 5000) this.sentTexts.delete(text)
      else if (plain.includes(text)) {
        this.sentTexts.delete(text)
        return true
      }
    }
    return false
  }

  // --- status / players -------------------------------------------------
  statusPayload () {
    const bot = this.bot
    if (!bot?.entity) return null
    const p = bot.entity.position
    return {
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      yaw: Math.round(bot.entity.yaw * 1000) / 1000,
      pitch: Math.round(bot.entity.pitch * 1000) / 1000,
      dim: bot.game?.dimension ?? null,
      hp: bot.health ?? null,
      food: bot.food ?? null,
      sat: bot.foodSaturation ?? null,
      xpLvl: bot.experience?.level ?? null,
      gm: bot.game?.gameMode ?? null,
      quick: bot.quickBarSlot,
      actionbar: this.actionbar,
      target: this.targetName(),
      ctl: this.movement ? this.movement.ctlState() : null
    }
  }

  targetName () {
    const now = Date.now()
    if (now - this.lastTargetAt < 500) return this.lastTarget
    this.lastTargetAt = now
    const bot = this.bot
    if (!bot) return null
    try {
      const entity = bot.entityAtCursor(3.5)
      if (entity) {
        const name = entity.username || entity.displayName || entity.name || `entity ${entity.id}`
        this.lastTarget = { kind: 'entity', name }
        return this.lastTarget
      }
      const block = bot.blockAtCursor(4.5)
      if (block) {
        this.lastTarget = { kind: 'block', name: block.displayName || block.name }
        return this.lastTarget
      }
    } catch {}
    this.lastTarget = null
    return null
  }

  sendStatus () {
    if (this.state !== 'online' || !this.bot) return
    try {
      const status = this.statusPayload()
      if (status) this.sendToSubscribers({ t: 'status', s: this.id, ...status })
    } catch {}
  }

  playersPayload () {
    const bot = this.bot
    if (!bot) return []
    const out = []
    for (const player of Object.values(bot.players || {})) {
      if (!player || player.username === bot.username) continue
      const entry = { name: player.username, ping: player.ping ?? null, gm: player.gamemode ?? null }
      const entity = player.entity
      if (entity && bot.entity && entity.position.distanceTo(bot.entity.position) < 64) {
        entry.x = Math.round(entity.position.x * 10) / 10
        entry.z = Math.round(entity.position.z * 10) / 10
      }
      out.push(entry)
    }
    return out
  }

  sendPlayers () {
    if (this.state !== 'online') return
    try {
      this.sendToSubscribers({ t: 'players', s: this.id, players: this.playersPayload() })
    } catch {}
  }

  // --- client messages --------------------------------------------------
  features () {
    return {
      goto: Boolean(this.bot?.pathfinder) && this.state === 'online',
      clickModes: ['normal', 'shift'],
      tabComplete: true,
      notifications: Boolean(this.termux?.available?.notifications),
      wakeLock: Boolean(this.termux?.available?.wakeLock)
    }
  }

  snapshot () {
    const inventoryState = this.inventory
      ? this.inventory.snapshot()
      : { inventory: null, window: null, cursor: null }
    return {
      t: 'snapshot',
      s: this.id,
      state: this.state,
      reason: this.reason,
      detail: this.detail,
      status: this.state === 'online' ? this.statusPayload() : null,
      inventory: inventoryState.inventory,
      window: inventoryState.window,
      cursor: inventoryState.cursor,
      chat: this.chatLog.backlog(),
      players: this.state === 'online' ? this.playersPayload() : [],
      features: this.features()
    }
  }

  tileBatches () {
    if (!this.minimap) return []
    const tiles = this.minimap.allTiles()
    const batches = []
    for (let i = 0; i < tiles.length; i += 32) batches.push(tiles.slice(i, i + 32))
    return batches
  }

  sendToSubscribers (msg) {
    this.hub.sendToSubscribers(this.id, msg)
  }

  sendChat (text) {
    if (!this.bot || this.state !== 'online') {
      throw Object.assign(new Error('session is not online'), { code: 'not_online' })
    }
    const oldLimit = (() => {
      try {
        return this.bot.supportFeature('lessCharsInChat')
      } catch {
        return false
      }
    })()
    const result = validateChatText(text, { oldLimit })
    if (!result.ok) throw Object.assign(new Error(result.msg), { code: result.code })
    const sent = text
    this.sentTexts.set(sent, Date.now())
    this.alerts.noteSent(sent)
    const line = this.chatLog.add(sent, 'chat', this.bot.username, { echo: true })
    try {
      this.bot.chat(sent)
    } catch (err) {
      throw Object.assign(new Error(`chat failed: ${err.message}`), { code: 'chat_failed' })
    }
    this.sendToSubscribers({ t: 'chat', s: this.id, ts: line.ts, plain: line.plain, segs: line.segs, echo: true })
  }

  async sendTab (text) {
    if (!this.bot || this.state !== 'online') {
      throw Object.assign(new Error('session is not online'), { code: 'not_online' })
    }
    if (!this.tabLimiter()) {
      throw Object.assign(new Error('too many tab-complete requests'), { code: 'rate_limited' })
    }
    let items = []
    try {
      const result = await this.bot.tabComplete(text, text.startsWith('/'))
      items = (result || []).slice(0, 20).map(item => item.match || String(item))
    } catch (err) {
      throw Object.assign(new Error(`tab-complete failed: ${err.message}`), { code: 'tab_failed' })
    }
    return items
  }

  async interact () {
    const bot = this.bot
    if (!bot || this.state !== 'online') throw Object.assign(new Error('session is not online'), { code: 'not_online' })
    const entity = bot.entityAtCursor(3.5)
    if (entity) {
      await bot.activateEntity(entity)
      return
    }
    const block = bot.blockAtCursor(4.5)
    if (!block) throw Object.assign(new Error('nothing within reach under the crosshair'), { code: 'nothing_there' })
    await bot.activateBlock(block)
  }

  async useItem () {
    const bot = this.bot
    if (!bot || this.state !== 'online') throw Object.assign(new Error('session is not online'), { code: 'not_online' })
    await bot.activateItem()
  }

  async handle (msg, clientId) {
    const bot = this.bot
    switch (msg.t) {
      case 'chat':
        this.sendChat(msg.text)
        return
      case 'tab':
        return { t: 'tab', s: this.id, items: await this.sendTab(msg.text) }
      case 'ctl':
        if (!this.movement) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        this.movement.setControl(msg.k, msg.on, clientId)
        return
      case 'hold':
        this.movement?.hold(clientId)
        return
      case 'look':
        if (!this.movement) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        this.movement.look(msg.yaw, msg.pitch)
        return
      case 'lookAt':
        if (!this.movement) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        this.movement.lookAt(msg.x, msg.y, msg.z)
        return
      case 'goto':
        if (!this.movement) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        this.movement.startGoto(msg.x, msg.z, msg.y)
        return
      case 'step':
        if (!this.movement) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        this.movement.step(msg.dir, msg.n)
        return
      case 'stop':
        if (this.movement) this.movement.stopAll()
        return
      case 'interact':
        await this.interact()
        return
      case 'use':
        await this.useItem()
        return
      case 'hotbar':
        if (!bot) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        bot.setQuickBarSlot(msg.i)
        return
      case 'click':
        if (!this.inventory) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        await this.inventory.click(msg)
        return
      case 'drop':
        if (!this.inventory) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        await this.inventory.drop(msg.slot, msg.all)
        return
      case 'closeWindow':
        if (!bot) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
        if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
        return
      default:
        throw Object.assign(new Error(`unsupported message ${msg.t}`), { code: 'unsupported' })
    }
  }

  destroy () {
    this.manualStop = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.onlineResetTimer) clearTimeout(this.onlineResetTimer)
    if (this.bot) this.settle('stop', 'stopped')
    this.teardownModules()
    this.alerts.destroy()
  }
}
