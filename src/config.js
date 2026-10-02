import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const ID_RE = /^[a-z0-9_-]{1,32}$/
export const SESSION_ID_RE = /^[a-z0-9_-]{1,32}@[a-z0-9_-]{1,32}$/
export const CONFIG_VERSION = 1

export const SHARED_STORAGE_ROOTS = ['/sdcard', '/storage']

export function expandHome (p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function defaultConfig () {
  return {
    version: CONFIG_VERSION,
    http: { port: 8765 },
    accounts: [],
    servers: [],
    autostart: [],
    minimap: { radiusChunks: 6 },
    deadmanMs: 600,
    termux: { wakeLock: true, notifications: true }
  }
}

function realpathNearest (p) {
  let current = path.resolve(p)
  while (true) {
    try {
      const real = fs.realpathSync(current)
      return { real, tail: path.relative(current, path.resolve(p)) }
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return { real: current, tail: '' }
      current = parent
    }
  }
}

// Refuse data dirs on Android shared storage: other apps can read them.
export function assertNotSharedStorage (dir, roots = SHARED_STORAGE_ROOTS) {
  const resolved = realpathNearest(dir)
  const realDir = resolved.tail ? path.join(resolved.real, resolved.tail) : resolved.real
  for (const root of roots) {
    let realRoot = root
    try {
      realRoot = fs.realpathSync(root)
    } catch {}
    const isInside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
    if (isInside(realDir, realRoot)) {
      throw new Error(`refusing data dir ${dir}: ${realDir} is on shared storage (${root}); Android apps other than Termux can read it. Use a path under the Termux home directory, e.g. ~/.golemlink`)
    }
  }
  return realDir
}

export function resolveDataDir (arg) {
  const dir = path.resolve(expandHome(arg || '~/.golemlink'))
  assertNotSharedStorage(dir)
  return dir
}

export function ensureDir (dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode })
  try {
    fs.chmodSync(dir, mode)
  } catch {}
}

export function ensureDataDir (dir) {
  ensureDir(dir, 0o700)
  ensureDir(path.join(dir, 'auth'), 0o700)
  ensureDir(path.join(dir, 'logs'), 0o700)
  return { token: loadOrCreateToken(dir) }
}

export function tokenPath (dir) {
  return path.join(dir, 'token')
}

export function loadOrCreateToken (dir) {
  const file = tokenPath(dir)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {}
  const token = crypto.randomBytes(32).toString('base64url')
  fs.writeFileSync(file, token + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  return token
}

export function configPath (dir) {
  return path.join(dir, 'config.json')
}

export function loadConfig (dir) {
  const file = configPath(dir)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return { config: defaultConfig(), errors: [], created: true }
    throw new Error(`cannot read ${file}: ${err.message}`)
  }
  const { config, errors } = validateConfig(raw)
  return { config, errors, created: false }
}

export function saveConfig (dir, config) {
  const file = configPath(dir)
  const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`)
  const data = JSON.stringify(config, null, 2) + '\n'
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {}
  fs.renameSync(tmp, file)
  return file
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function copyUnknown (source, keys) {
  const out = {}
  if (!isPlainObject(source)) return out
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) out[key] = value
  }
  return out
}

export function validateAccount (raw, { errors = [], prefix = 'account' } = {}) {
  if (!isPlainObject(raw)) {
    errors.push(`${prefix}: expected an object`)
    return { value: null, errors }
  }
  const account = { ...copyUnknown(raw, ['id', 'auth', 'username']) }
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    errors.push(`${prefix}.id must match ${ID_RE}`)
  } else {
    account.id = raw.id
  }
  if (raw.auth !== 'microsoft' && raw.auth !== 'offline') {
    errors.push(`${prefix}.auth must be "microsoft" or "offline"`)
  } else {
    account.auth = raw.auth
  }
  if (typeof raw.username !== 'string' || raw.username.length < 1 || raw.username.length > 128) {
    errors.push(`${prefix}.username must be a non-empty string of at most 128 characters`)
  } else {
    account.username = raw.username
  }
  return { value: account, errors }
}

export function validateAutoLogin (raw, { errors = [], prefix = 'server', partial = false } = {}) {
  if (raw === null || raw === undefined) return { value: null, errors }
  if (!isPlainObject(raw)) {
    errors.push(`${prefix}.autoLogin must be null or an object`)
    return { value: null, errors }
  }
  const out = { ...copyUnknown(raw, ['password', 'trigger']) }
  if (raw.password === undefined && partial) {
    // keep the existing password (filled in by the config layer)
  } else if (typeof raw.password !== 'string' || raw.password.length > 256) {
    errors.push(`${prefix}.autoLogin.password must be a string of at most 256 characters`)
  } else {
    out.password = raw.password
  }
  if (typeof raw.trigger !== 'string' || raw.trigger.length < 1 || raw.trigger.length > 256) {
    errors.push(`${prefix}.autoLogin.trigger must be a non-empty string of at most 256 characters`)
  } else {
    try {
      compileTrigger(raw.trigger)
      out.trigger = raw.trigger
    } catch {
      errors.push(`${prefix}.autoLogin.trigger is not a valid regular expression`)
    }
  }
  return { value: out, errors }
}

export function compileTrigger (trigger) {
  const match = /^\/(.+)\/([a-z]*)$/.exec(trigger)
  if (match) return new RegExp(match[1], match[2])
  return new RegExp(escapeRegex(trigger), 'i')
}

function escapeRegex (text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function validateServer (raw, { errors = [], prefix = 'server', partial = false } = {}) {
  if (!isPlainObject(raw)) {
    errors.push(`${prefix}: expected an object`)
    return { value: null, errors }
  }
  const known = ['id', 'name', 'host', 'port', 'version', 'autoReconnect', 'chatLog', 'antiAfk', 'alerts', 'resourcePack', 'autoLogin']
  const server = { ...copyUnknown(raw, known) }

  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    errors.push(`${prefix}.id must match ${ID_RE}`)
  } else {
    server.id = raw.id
  }
  server.name = typeof raw.name === 'string' && raw.name.length > 0 && raw.name.length <= 64 ? raw.name : raw.id
  if (typeof raw.host !== 'string' || raw.host.length < 1 || raw.host.length > 253) {
    errors.push(`${prefix}.host must be a non-empty string of at most 253 characters`)
  } else {
    server.host = raw.host
  }
  if (raw.port === undefined) {
    server.port = 25565
  } else if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
    errors.push(`${prefix}.port must be an integer between 1 and 65535`)
  } else {
    server.port = raw.port
  }
  if (raw.version === undefined) {
    server.version = 'auto'
  } else if (typeof raw.version !== 'string' || raw.version.length > 32) {
    errors.push(`${prefix}.version must be a string`)
  } else {
    server.version = raw.version
  }
  server.autoReconnect = raw.autoReconnect === undefined ? true : Boolean(raw.autoReconnect)
  server.chatLog = raw.chatLog === undefined ? true : Boolean(raw.chatLog)

  const antiAfk = isPlainObject(raw.antiAfk) ? raw.antiAfk : {}
  const antiAfkOut = { ...copyUnknown(antiAfk, ['enabled', 'intervalSec']) }
  antiAfkOut.enabled = antiAfk.enabled === undefined ? false : Boolean(antiAfk.enabled)
  if (antiAfk.intervalSec === undefined) {
    antiAfkOut.intervalSec = 90
  } else if (!Number.isFinite(antiAfk.intervalSec) || antiAfk.intervalSec < 5 || antiAfk.intervalSec > 3600) {
    errors.push(`${prefix}.antiAfk.intervalSec must be between 5 and 3600`)
  } else {
    antiAfkOut.intervalSec = Math.round(antiAfk.intervalSec)
  }
  server.antiAfk = antiAfkOut

  const alerts = isPlainObject(raw.alerts) ? raw.alerts : {}
  const alertsOut = { ...copyUnknown(alerts, ['keywords', 'damage', 'death']) }
  if (alerts.keywords === undefined) {
    alertsOut.keywords = []
  } else if (!Array.isArray(alerts.keywords) || alerts.keywords.some(k => typeof k !== 'string' || k.length < 1 || k.length > 128)) {
    errors.push(`${prefix}.alerts.keywords must be an array of non-empty strings`)
  } else {
    alertsOut.keywords = alerts.keywords.slice(0, 64)
  }
  alertsOut.damage = alerts.damage === undefined ? true : Boolean(alerts.damage)
  alertsOut.death = alerts.death === undefined ? true : Boolean(alerts.death)
  server.alerts = alertsOut

  if (raw.resourcePack === undefined) {
    server.resourcePack = 'accept'
  } else if (raw.resourcePack !== 'accept' && raw.resourcePack !== 'deny') {
    errors.push(`${prefix}.resourcePack must be "accept" or "deny"`)
  } else {
    server.resourcePack = raw.resourcePack
  }

  const autoLogin = validateAutoLogin(raw.autoLogin, { errors, prefix, partial })
  server.autoLogin = autoLogin.value

  return { value: server, errors }
}

export function validateConfig (raw) {
  const errors = []
  if (!isPlainObject(raw)) {
    errors.push('config root must be a JSON object')
    return { config: defaultConfig(), errors }
  }
  // Migrate by version. Version 1 is the only version so far.
  const version = raw.version === undefined ? CONFIG_VERSION : raw.version
  if (!Number.isInteger(version) || version < 1) {
    errors.push('config.version must be a positive integer')
  } else if (version > CONFIG_VERSION) {
    errors.push(`config.version ${version} is newer than this daemon supports (${CONFIG_VERSION})`)
  }

  const config = { ...copyUnknown(raw, ['version', 'http', 'accounts', 'servers', 'autostart', 'minimap', 'deadmanMs', 'termux']) }
  config.version = CONFIG_VERSION

  const http = isPlainObject(raw.http) ? raw.http : {}
  const httpOut = { ...copyUnknown(http, ['port']) }
  if (http.port === undefined) {
    httpOut.port = 8765
  } else if (!Number.isInteger(http.port) || http.port < 1 || http.port > 65535) {
    errors.push('http.port must be an integer between 1 and 65535')
  } else {
    httpOut.port = http.port
  }
  config.http = httpOut

  config.accounts = []
  if (raw.accounts !== undefined && !Array.isArray(raw.accounts)) {
    errors.push('accounts must be an array')
  } else {
    for (const [i, entry] of (raw.accounts || []).entries()) {
      const { value } = validateAccount(entry, { errors, prefix: `accounts[${i}]` })
      if (value && value.id) config.accounts.push(value)
    }
    const ids = new Set()
    for (const account of config.accounts) {
      if (ids.has(account.id)) errors.push(`duplicate account id "${account.id}"`)
      ids.add(account.id)
    }
  }

  config.servers = []
  if (raw.servers !== undefined && !Array.isArray(raw.servers)) {
    errors.push('servers must be an array')
  } else {
    for (const [i, entry] of (raw.servers || []).entries()) {
      const { value } = validateServer(entry, { errors, prefix: `servers[${i}]` })
      if (value && value.id) config.servers.push(value)
    }
    const ids = new Set()
    for (const server of config.servers) {
      if (ids.has(server.id)) errors.push(`duplicate server id "${server.id}"`)
      ids.add(server.id)
    }
  }

  config.autostart = []
  if (raw.autostart !== undefined && !Array.isArray(raw.autostart)) {
    errors.push('autostart must be an array of "<account>@<server>" strings')
  } else {
    for (const entry of raw.autostart || []) {
      if (typeof entry !== 'string' || !SESSION_ID_RE.test(entry)) {
        errors.push(`autostart entry ${JSON.stringify(entry)} must match <account>@<server>`)
      } else {
        config.autostart.push(entry)
      }
    }
  }

  const minimap = isPlainObject(raw.minimap) ? raw.minimap : {}
  const minimapOut = { ...copyUnknown(minimap, ['radiusChunks']) }
  if (minimap.radiusChunks === undefined) {
    minimapOut.radiusChunks = 6
  } else if (!Number.isInteger(minimap.radiusChunks) || minimap.radiusChunks < 1 || minimap.radiusChunks > 16) {
    errors.push('minimap.radiusChunks must be an integer between 1 and 16')
  } else {
    minimapOut.radiusChunks = minimap.radiusChunks
  }
  config.minimap = minimapOut

  if (raw.deadmanMs === undefined) {
    config.deadmanMs = 600
  } else if (!Number.isFinite(raw.deadmanMs) || raw.deadmanMs < 100 || raw.deadmanMs > 60000) {
    errors.push('deadmanMs must be between 100 and 60000')
  } else {
    config.deadmanMs = Math.round(raw.deadmanMs)
  }

  const termux = isPlainObject(raw.termux) ? raw.termux : {}
  config.termux = {
    ...copyUnknown(termux, ['wakeLock', 'notifications']),
    wakeLock: termux.wakeLock === undefined ? true : Boolean(termux.wakeLock),
    notifications: termux.notifications === undefined ? true : Boolean(termux.notifications)
  }

  return { config, errors }
}

// Apply an incoming server update to an existing store entry. Auto-login
// passwords never reach the UI: a missing password keeps the old one, an
// empty string removes auto-login entirely.
export function applyServerUpdate (existing, update) {
  const merged = { ...(existing || {}), ...update }
  if (!update || update.autoLogin === undefined) {
    merged.autoLogin = existing ? existing.autoLogin ?? null : null
  } else if (update.autoLogin === null) {
    merged.autoLogin = null
  } else if (typeof update.autoLogin === 'object') {
    const incoming = { ...update.autoLogin }
    if (incoming.password === '') {
      merged.autoLogin = null
    } else {
      if (incoming.password === undefined) {
        incoming.password = existing?.autoLogin?.password ?? ''
      }
      if (incoming.trigger === undefined) {
        incoming.trigger = existing?.autoLogin?.trigger ?? '/(login|log in)/i'
      }
      merged.autoLogin = incoming
    }
  }
  return merged
}

// Config shapes sent to the UI: secrets stripped, hasAutoLogin exposed.
export function sanitizeAccount (account) {
  const { ...safe } = account
  return safe
}

export function sanitizeServer (server) {
  const safe = { ...server, hasAutoLogin: Boolean(server.autoLogin) }
  delete safe.autoLogin
  return safe
}
