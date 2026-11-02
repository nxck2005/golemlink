import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const COOKIE_NAME = 'golemlink_login'
export const REMEMBER_MS = 90 * 24 * 60 * 60 * 1000
export const SHORT_MS = 7 * 24 * 60 * 60 * 1000
export const SETUP_CODE_MS = 15 * 60 * 1000
const SETUP_ATTEMPTS = 5
const MAX_LOGINS = 50
const TOUCH_SAVE_MS = 5 * 60 * 1000
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }
const USERNAME_RE = /^[\w.@-]{1,64}$/

// Sign-in attempts allowed per IP per minute, and across all IPs.
const PER_IP_LIMIT = 5
const GLOBAL_LIMIT = 20
const WINDOW_MS = 60 * 1000

export class AuthError extends Error {
  constructor (code, message, status = 400, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

export function authPath (dataDir) {
  return path.join(dataDir, 'auth.json')
}

function scrypt (password, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

export async function hashPassword (password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt)
  return { alg: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), key: key.toString('base64') }
}

export async function verifyPassword (password, hash) {
  if (!hash || hash.alg !== 'scrypt') return false
  const expected = Buffer.from(hash.key, 'base64')
  const key = await scrypt(password, Buffer.from(hash.salt, 'base64'), { N: hash.N, r: hash.r, p: hash.p, keylen: expected.length })
  return crypto.timingSafeEqual(key, expected)
}

function digest (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function safeEqual (a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest()
  const right = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(left, right)
}

export function checkPassword (password) {
  if (typeof password !== 'string' || password.length < 8) throw new AuthError('weak_password', 'Use at least 8 characters for the password')
  if (password.length > 256) throw new AuthError('weak_password', 'Use at most 256 characters for the password')
}

export function checkUsername (username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new AuthError('bad_username', 'Use 1–64 letters, numbers, dots, dashes, underscores or @ for the username')
  }
}

// A short readable label for the signed-in devices list.
export function deviceLabel (userAgent = '') {
  const ua = String(userAgent)
  let browser = 'Browser'
  if (/Edg\//.test(ua)) browser = 'Edge'
  else if (/Firefox\//.test(ua)) browser = 'Firefox'
  else if (/Chrome\//.test(ua)) browser = 'Chrome'
  else if (/Safari\//.test(ua)) browser = 'Safari'
  let system = ''
  if (/iPhone/.test(ua)) system = 'iPhone'
  else if (/iPad/.test(ua)) system = 'iPad'
  else if (/Android/.test(ua)) system = 'Android'
  else if (/Windows/.test(ua)) system = 'Windows'
  else if (/Mac OS X|Macintosh/.test(ua)) system = 'Mac'
  else if (/Linux/.test(ua)) system = 'Linux'
  return system ? `${browser} on ${system}` : browser
}

export function parseCookies (header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    if (!key || key in out) continue
    out[key] = part.slice(index + 1).trim()
  }
  return out
}

export function loginCookie (token, { remember, secure }) {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']
  if (remember) parts.push(`Max-Age=${Math.floor(REMEMBER_MS / 1000)}`)
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearCookie ({ secure }) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export class Auth {
  constructor ({ dataDir, logger, now = Date.now, onSetupCode, onRevoke } = {}) {
    this.file = authPath(dataDir)
    this.logger = logger
    this.now = now
    this.onSetupCode = onSetupCode || (() => {})
    this.onRevoke = onRevoke || (() => {})
    this.setup = null
    this.attempts = new Map()
    this.globalAttempts = []
    this.dirty = false
    this.lastSave = 0
    this.data = this.load()
  }

  load () {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger?.warn?.(`cannot read ${this.file}: ${err.message}; starting without a login`)
      return { version: 1, owner: null, logins: [] }
    }
    const owner = raw?.owner && typeof raw.owner.username === 'string' && raw.owner.hash ? raw.owner : null
    const logins = Array.isArray(raw?.logins) ? raw.logins.filter(l => l && typeof l.id === 'string') : []
    return { version: 1, owner, logins }
  }

  save () {
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {}
    fs.renameSync(tmp, this.file)
    this.dirty = false
    this.lastSave = this.now()
  }

  flush () {
    if (this.dirty) this.save()
  }

  isSetUp () {
    return Boolean(this.data.owner)
  }

  username () {
    return this.data.owner?.username || null
  }

  // The current setup code, made fresh when there is none or it expired.
  setupCode () {
    if (this.isSetUp()) return null
    const now = this.now()
    if (!this.setup || now >= this.setup.expires || this.setup.attempts >= SETUP_ATTEMPTS) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
      this.setup = { code, expires: now + SETUP_CODE_MS, attempts: 0 }
      this.onSetupCode(code, this.setup.expires)
    }
    return this.setup
  }

  limit (ip) {
    const now = this.now()
    this.globalAttempts = this.globalAttempts.filter(t => now - t < WINDOW_MS)
    const mine = (this.attempts.get(ip) || []).filter(t => now - t < WINDOW_MS)
    this.attempts.set(ip, mine)
    const full = mine.length >= PER_IP_LIMIT ? mine : this.globalAttempts.length >= GLOBAL_LIMIT ? this.globalAttempts : null
    if (full) {
      const retryAfter = Math.max(1, Math.ceil((full[0] + WINDOW_MS - now) / 1000))
      throw new AuthError('rate_limited', `Too many attempts. Try again in ${retryAfter} s`, 429, { retryAfter })
    }
  }

  fail (ip) {
    const now = this.now()
    const mine = this.attempts.get(ip) || []
    mine.push(now)
    this.attempts.set(ip, mine)
    this.globalAttempts.push(now)
    if (this.attempts.size > 1000) this.attempts.clear()
  }

  async createOwner ({ code, username, password, remember, userAgent, ip }) {
    if (this.isSetUp()) throw new AuthError('already_set_up', 'This golemlink already has a login. Sign in instead', 409)
    this.limit(ip)
    const setup = this.setupCode()
    setup.attempts++
    if (typeof code !== 'string' || !safeEqual(code.replace(/\s+/g, ''), setup.code) || this.now() >= setup.expires) {
      this.fail(ip)
      if (setup.attempts >= SETUP_ATTEMPTS) {
        this.setupCode()
        throw new AuthError('bad_code', 'Too many wrong codes. A new setup code is in the daemon output', 403)
      }
      throw new AuthError('bad_code', 'That setup code is wrong or expired. Check the daemon output for the current one', 403)
    }
    checkUsername(username)
    checkPassword(password)
    this.data.owner = { username, hash: await hashPassword(password), created: this.now() }
    this.data.logins = []
    this.setup = null
    const token = this.addLogin({ remember, userAgent, ip })
    this.save()
    this.logger?.info?.(`login created for ${username}`)
    return token
  }

  async signIn ({ username, password, remember, userAgent, ip }) {
    if (!this.isSetUp()) throw new AuthError('not_set_up', 'Set up a login first', 409)
    this.limit(ip)
    const nameOk = typeof username === 'string' && safeEqual(username.toLowerCase(), this.data.owner.username.toLowerCase())
    const passOk = typeof password === 'string' && password.length <= 256 && await verifyPassword(password, this.data.owner.hash)
    if (!nameOk || !passOk) {
      this.fail(ip)
      this.logger?.warn?.(`failed sign-in from ${ip}`)
      throw new AuthError('bad_login', 'Wrong username or password', 401)
    }
    this.attempts.delete(ip)
    const token = this.addLogin({ remember, userAgent, ip })
    this.save()
    return token
  }

  addLogin ({ remember, userAgent, ip }) {
    const token = crypto.randomBytes(32).toString('base64url')
    const now = this.now()
    this.data.logins.push({
      id: digest(token),
      label: deviceLabel(userAgent),
      ip: ip || null,
      remember: Boolean(remember),
      created: now,
      lastUsed: now
    })
    this.data.logins.sort((a, b) => b.lastUsed - a.lastUsed)
    this.data.logins.length = Math.min(this.data.logins.length, MAX_LOGINS)
    return token
  }

  expired (login, now = this.now()) {
    return now - login.lastUsed > (login.remember ? REMEMBER_MS : SHORT_MS)
  }

  // The login record for a cookie token, or null. Marks it used.
  verify (token, { ip } = {}) {
    if (!this.isSetUp() || typeof token !== 'string' || token.length < 20 || token.length > 128) return null
    const id = digest(token)
    const login = this.data.logins.find(l => l.id === id)
    if (!login) return null
    const now = this.now()
    if (this.expired(login, now)) {
      this.revoke(login.id)
      return null
    }
    login.lastUsed = now
    if (ip) login.ip = ip
    this.dirty = true
    if (now - this.lastSave > TOUCH_SAVE_MS) this.save()
    return login
  }

  list () {
    const now = this.now()
    return this.data.logins
      .filter(l => !this.expired(l, now))
      .map(({ id, label, ip, created, lastUsed, remember }) => ({ id: id.slice(0, 16), label, ip, created, lastUsed, remember }))
  }

  // Signs out the login whose id (or id prefix from list()) matches.
  revoke (idOrPrefix) {
    if (typeof idOrPrefix !== 'string' || idOrPrefix.length < 16) return false
    const index = this.data.logins.findIndex(l => l.id.startsWith(idOrPrefix))
    if (index < 0) return false
    const [login] = this.data.logins.splice(index, 1)
    this.save()
    this.onRevoke(login.id)
    return true
  }

  async changePassword ({ current, next, keepId, ip }) {
    this.limit(ip)
    if (typeof current !== 'string' || !await verifyPassword(current, this.data.owner.hash)) {
      this.fail(ip)
      throw new AuthError('bad_login', 'The current password is wrong', 401)
    }
    checkPassword(next)
    this.data.owner.hash = await hashPassword(next)
    const others = this.data.logins.filter(l => l.id !== keepId)
    this.data.logins = this.data.logins.filter(l => l.id === keepId)
    this.save()
    for (const login of others) this.onRevoke(login.id)
  }

  // CLI reset: forget the login and every device, so the next start prints a
  // setup code.
  reset () {
    const ids = this.data.logins.map(l => l.id)
    this.data = { version: 1, owner: null, logins: [] }
    this.setup = null
    this.save()
    for (const id of ids) this.onRevoke(id)
  }
}
