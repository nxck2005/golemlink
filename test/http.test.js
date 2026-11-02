import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHttpServer } from '../src/http.js'
import { createApi } from '../src/api.js'
import { buildAccess } from '../src/access.js'
import { Auth } from '../src/auth.js'

async function startStatic ({ binds = [] } = {}) {
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-web-'))
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>ok</title>')
  fs.mkdirSync(path.join(webDir, 'sub'))
  fs.writeFileSync(path.join(webDir, 'sub', 'app.js'), 'export const x = 1\n')
  fs.writeFileSync(path.join(webDir, '.secret'), 'nope')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-data-'))
  const texRoot = path.join(dataDir, 'textures')
  fs.mkdirSync(path.join(texRoot, '1.21.11', 'item'), { recursive: true })
  fs.writeFileSync(path.join(texRoot, '1.21.11', 'item', 'stone.png'), 'png')
  const codes = []
  const auth = new Auth({ dataDir, onSetupCode: code => codes.push(code) })
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const access = buildAccess({ port, binds })
  const logger = { warn () {}, error () {}, info () {} }
  server.on('request', createHttpServer({ webDir, access, auth, textures: { root: texRoot }, api: createApi({ auth, access, logger }), logger }))
  const base = `http://127.0.0.1:${port}`
  const post = (url, body, headers = {}) => fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: JSON.stringify(body)
  })
  return { server, port, base, auth, codes, post, close: () => new Promise(resolve => server.close(resolve)) }
}

function cookieOf (res) {
  return res.headers.get('set-cookie').split(';')[0]
}

test('static server serves files with security headers', async () => {
  const { base, port, close } = await startStatic({ binds: ['100.64.1.2'] })
  try {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const csp = res.headers.get('content-security-policy')
    assert.match(csp, /default-src 'self'/)
    assert.match(csp, /object-src 'none'/)
    assert.match(csp, /font-src 'self'/)
    assert.ok(csp.includes(`ws://100.64.1.2:${port}`))
    assert.equal(await res.text(), '<!doctype html><title>ok</title>')
    const js = await fetch(`${base}/sub/app.js`)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /javascript/)
  } finally {
    await close()
  }
})

test('unknown Host headers are refused (DNS rebinding)', async () => {
  const { port, close } = await startStatic()
  try {
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: `evil.example:${port}` } }, res => {
        res.resume()
        resolve(res.statusCode)
      }).on('error', reject)
    })
    assert.equal(status, 421)
  } finally {
    await close()
  }
})

test('traversal and dotfiles are rejected', async () => {
  const { base, close } = await startStatic()
  try {
    for (const url of ['/%2e%2e%2f%2e%2e%2fpackage.json', '/sub%2f..%2f..%2fpackage.json', '/.secret', '/sub/.env', '/textures/..%2f..%2fauth.json']) {
      assert.ok([401, 404].includes((await fetch(base + url)).status), url)
    }
  } finally {
    await close()
  }
})

test('only GET and HEAD are allowed for files', async () => {
  const { base, close } = await startStatic()
  try {
    const post = await fetch(`${base}/`, { method: 'POST' })
    assert.equal(post.status, 405)
    const head = await fetch(`${base}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String('<!doctype html><title>ok</title>'.length))
    assert.equal((await fetch(`${base}/nope.txt`)).status, 404)
  } finally {
    await close()
  }
})

test('setup, sign-in, devices and sign-out over the API', async () => {
  const { base, post, codes, close } = await startStatic()
  try {
    assert.deepEqual(await (await fetch(`${base}/api/me`)).json(), { setUp: false, signedIn: false })
    const wrong = await post('/api/setup', { code: '1', username: 'nick', password: 'password123' })
    assert.equal(wrong.status, 403)
    const foreign = await post('/api/setup', { code: codes.at(-1), username: 'nick', password: 'password123' }, { Origin: 'http://evil.example' })
    assert.equal(foreign.status, 403)
    const setup = await post('/api/setup', { code: codes.at(-1), username: 'nick', password: 'password123' })
    assert.equal(setup.status, 200)
    assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=/)
    const cookie = cookieOf(setup)

    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()
    assert.equal(me.signedIn, true)
    assert.equal(me.username, 'nick')

    const bad = await post('/api/login', { username: 'nick', password: 'nope' })
    assert.equal(bad.status, 401)
    const second = await post('/api/login', { username: 'nick', password: 'password123', remember: false })
    assert.equal(second.status, 200)
    assert.doesNotMatch(second.headers.get('set-cookie'), /Max-Age/)
    const secondCookie = cookieOf(second)

    const { logins } = await (await fetch(`${base}/api/logins`, { headers: { Cookie: cookie } })).json()
    assert.equal(logins.length, 2)
    assert.equal(logins.filter(l => l.current).length, 1)
    const other = logins.find(l => !l.current)
    const del = await fetch(`${base}/api/logins/${other.id}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } })
    assert.equal(del.status, 200)
    assert.equal((await (await fetch(`${base}/api/me`, { headers: { Cookie: secondCookie } })).json()).signedIn, false)

    assert.equal((await fetch(`${base}/textures/1.21.11/item/stone.png`)).status, 401)
    const png = await fetch(`${base}/textures/1.21.11/item/stone.png`, { headers: { Cookie: cookie } })
    assert.equal(png.status, 200)
    assert.equal(png.headers.get('content-type'), 'image/png')

    const out = await post('/api/logout', {}, { Cookie: cookie })
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/)
    assert.equal((await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()).signedIn, false)
    assert.equal((await fetch(`${base}/api/logins`, { headers: { Cookie: cookie } })).status, 401)
  } finally {
    await close()
  }
})

test('API bodies must be small JSON', async () => {
  const { base, close } = await startStatic()
  try {
    const notJson = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: 'x' })
    assert.equal(notJson.status, 415)
    const huge = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(20000) }) }).catch(() => ({ status: 413 }))
    assert.equal(huge.status, 413)
  } finally {
    await close()
  }
})
