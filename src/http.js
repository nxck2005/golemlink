import fs from 'node:fs'
import path from 'node:path'

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

export function securityHeaders ({ port, unsafeBind }) {
  const connect = [
    "'self'",
    `ws://127.0.0.1:${port}`,
    `ws://localhost:${port}`
  ]
  if (unsafeBind) connect.push(`ws://${unsafeBind}:${port}`)
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connect.join(' ')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
}

export function createHttpServer ({ webDir, port, unsafeBind, logger }) {
  const root = path.resolve(webDir)
  const baseHeaders = securityHeaders({ port, unsafeBind })

  const server = (req, res) => {
    const headers = { ...baseHeaders }
    const method = req.method || 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' })
      res.end()
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
    if (pathname === '/') pathname = '/index.html'
    const relative = pathname.replace(/^\/+/, '')
    if (hasDotfile(relative)) {
      res.writeHead(404, headers)
      res.end('not found')
      return
    }
    const resolved = path.resolve(path.join(root, relative))
    if (!isInside(resolved, root)) {
      res.writeHead(404, headers)
      res.end('not found')
      return
    }
    let stat
    try {
      stat = fs.statSync(resolved)
    } catch {
      res.writeHead(404, headers)
      res.end('not found')
      return
    }
    if (!stat.isFile()) {
      res.writeHead(404, headers)
      res.end('not found')
      return
    }
    const ext = path.extname(resolved).toLowerCase()
    headers['Content-Type'] = MIME[ext] || 'application/octet-stream'
    if (ext === '.html') headers['Cache-Control'] = 'no-store'
    headers['Content-Length'] = stat.size
    res.writeHead(200, headers)
    if (method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(resolved)
    stream.on('error', err => {
      logger?.warn?.(`static file read failed: ${err.message}`)
      res.destroy()
    })
    stream.pipe(res)
  }

  return server
}
