import fs from 'node:fs'
import path from 'node:path'
import { parseCookies, COOKIE_NAME } from './auth.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
}

function isInside (child, parent) {
  const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep
  return child === parent || child.startsWith(parentWithSep)
}

function hasDotfile (relative) {
  return relative.split(/[/\\]/).some(part => part.startsWith('.') && part !== '')
}

export function securityHeaders ({ access }) {
  const connect = ["'self'", ...(access ? access.connectSources() : [])]
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src ${connect.join(' ')}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
}

function sendFile (req, res, headers, file, { cache, logger }) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    stat = null
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, headers)
    res.end('not found')
    return
  }
  const ext = path.extname(file).toLowerCase()
  headers['Content-Type'] = MIME[ext] || 'application/octet-stream'
  headers['Cache-Control'] = ext === '.html' ? 'no-store' : cache
  headers['Content-Length'] = stat.size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(file)
  stream.on('error', err => {
    logger?.warn?.(`static file read failed: ${err.message}`)
    res.destroy()
  })
  stream.pipe(res)
}

// Resolves a URL path below root, or null for traversal and dotfiles.
function resolveBelow (root, relative) {
  if (hasDotfile(relative)) return null
  const resolved = path.resolve(path.join(root, relative))
  return isInside(resolved, root) && resolved !== root ? resolved : null
}

export function createHttpServer ({ webDir, access, api, auth, textures, logger }) {
  const root = path.resolve(webDir)
  const baseHeaders = securityHeaders({ access })

  return (req, res) => {
    const headers = { ...baseHeaders }
    const method = req.method || 'GET'

    if (access && !access.hostAllowed(req.headers.host)) {
      res.writeHead(421, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`golemlink does not answer to the host name "${String(req.headers.host || '').slice(0, 100)}". Add it to http.allowedHosts in config.json.\n`)
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      res.writeHead(400, headers)
      res.end()
      return
    }
    if (pathname.includes('\0')) {
      res.writeHead(400, headers)
      res.end()
      return
    }

    if (api && pathname.startsWith('/api/')) {
      api(req, res, headers, pathname)
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' })
      res.end()
      return
    }

    if (textures && pathname.startsWith('/textures/')) {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
      if (!auth?.verify(token)) {
        res.writeHead(401, headers)
        res.end('sign in first')
        return
      }
      const file = resolveBelow(textures.root, pathname.slice('/textures/'.length))
      if (!file) {
        res.writeHead(404, headers)
        res.end('not found')
        return
      }
      sendFile(req, res, headers, file, { cache: 'private, max-age=604800', logger })
      return
    }

    if (pathname === '/') pathname = '/index.html'
    const file = resolveBelow(root, pathname.replace(/^\/+/, ''))
    if (!file) {
      res.writeHead(404, headers)
      res.end('not found')
      return
    }
    sendFile(req, res, headers, file, { cache: 'no-cache', logger })
  }
}
