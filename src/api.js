import { AuthError, COOKIE_NAME, parseCookies, loginCookie, clearCookie } from './auth.js'

const MAX_BODY = 8 * 1024

export function clientIp (req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown'
}

// HTTPS only when the request arrived over TLS, or through a local reverse
// proxy such as `tailscale serve` that says so.
export function isSecure (req) {
  if (req.socket?.encrypted) return true
  const ip = clientIp(req)
  const local = ip === '127.0.0.1' || ip === '::1'
  return local && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https'
}

export function cookieToken (req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '')
    if (!/^application\/json\b/i.test(type)) {
      reject(new AuthError('bad_request', 'Expected a JSON body', 415))
      return
    }
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new AuthError('bad_request', 'Request body is too large', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
        resolve(value)
      } catch {
        reject(new AuthError('bad_request', 'Request body is not valid JSON', 400))
      }
    })
    req.on('error', reject)
  })
}

function reply (res, headers, status, body, extra = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...headers,
    ...extra,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

export function createApi ({ auth, access, logger }) {
  // The signed-in login for a request, or null.
  function sessionFor (req) {
    return auth.verify(cookieToken(req), { ip: clientIp(req) })
  }

  async function route (req, method, pathname) {
    const ip = clientIp(req)
    const userAgent = req.headers['user-agent'] || ''
    const secure = isSecure(req)

    if (method === 'GET' && pathname === '/api/me') {
      if (!auth.isSetUp()) {
        auth.setupCode()
        return { status: 200, body: { setUp: false, signedIn: false } }
      }
      const login = sessionFor(req)
      if (!login) return { status: 200, body: { setUp: true, signedIn: false } }
      return { status: 200, body: { setUp: true, signedIn: true, username: auth.username(), login: login.id.slice(0, 16) } }
    }

    if (method !== 'GET') {
      // Cross-site forms and fetches carry a foreign Origin; refuse them.
      if (!access.originAllowed(req.headers.origin)) throw new AuthError('forbidden', 'Request from an unknown origin', 403)
    }

    if (method === 'POST' && pathname === '/api/setup') {
      const body = await readJson(req)
      const token = await auth.createOwner({ ...pick(body, ['code', 'username', 'password']), remember: body.remember !== false, userAgent, ip })
      return { status: 200, body: { ok: true }, cookie: loginCookie(token, { remember: body.remember !== false, secure }) }
    }
    if (method === 'POST' && pathname === '/api/login') {
      const body = await readJson(req)
      const token = await auth.signIn({ ...pick(body, ['username', 'password']), remember: body.remember === true, userAgent, ip })
      return { status: 200, body: { ok: true }, cookie: loginCookie(token, { remember: body.remember === true, secure }) }
    }
    if (method === 'POST' && pathname === '/api/logout') {
      const login = sessionFor(req)
      if (login) auth.revoke(login.id)
      return { status: 200, body: { ok: true }, cookie: clearCookie({ secure }) }
    }

    const login = sessionFor(req)
    if (!login) throw new AuthError('signed_out', 'Sign in first', 401)

    if (method === 'POST' && pathname === '/api/password') {
      const body = await readJson(req)
      await auth.changePassword({ current: body.current, next: body.next, keepId: login.id, ip })
      return { status: 200, body: { ok: true } }
    }
    if (method === 'GET' && pathname === '/api/logins') {
      const current = login.id.slice(0, 16)
      return { status: 200, body: { logins: auth.list().map(l => ({ ...l, current: l.id === current })) } }
    }
    const match = /^\/api\/logins\/([0-9a-f]{16})$/.exec(pathname)
    if (method === 'DELETE' && match) {
      if (!auth.revoke(match[1])) throw new AuthError('not_found', 'That device is already signed out', 404)
      return { status: 200, body: { ok: true } }
    }
    throw new AuthError('not_found', 'Unknown API route', 404)
  }

  return async function handle (req, res, headers, pathname) {
    const method = req.method || 'GET'
    try {
      const result = await route(req, method, pathname)
      reply(res, headers, result.status, result.body, result.cookie ? { 'Set-Cookie': result.cookie } : {})
    } catch (err) {
      if (err instanceof AuthError) {
        const extra = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {}
        reply(res, headers, err.status, { error: err.code, message: err.message, retryAfter: err.retryAfter }, extra)
        return
      }
      logger?.error?.(`api ${method} ${pathname} failed: ${err?.stack || err}`)
      if (!res.headersSent) reply(res, headers, 500, { error: 'internal', message: 'Internal error' })
    }
  }
}

function pick (body, keys) {
  const out = {}
  for (const key of keys) out[key] = body[key]
  return out
}
