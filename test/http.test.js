import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHttpServer } from '../src/http.js'

async function startStatic (unsafeBind = null) {
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-web-'))
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>ok</title>')
  fs.mkdirSync(path.join(webDir, 'sub'))
  fs.writeFileSync(path.join(webDir, 'sub', 'app.js'), 'export const x = 1\n')
  fs.writeFileSync(path.join(webDir, '.secret'), 'nope')
  const server = http.createServer(createHttpServer({
    webDir,
    port: 12345,
    unsafeBind,
    logger: { warn () {} }
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, webDir }
}

test('static server serves files with security headers', async () => {
  const { server, port } = await startStatic()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const csp = res.headers.get('content-security-policy')
    assert.match(csp, /default-src 'self'/)
    assert.match(csp, /object-src 'none'/)
    assert.match(csp, new RegExp(`ws://127\\.0\\.0\\.1:12345`))
    assert.match(csp, /ws:\/\/localhost:12345/)
    assert.equal(await res.text(), '<!doctype html><title>ok</title>')

    const js = await fetch(`http://127.0.0.1:${port}/sub/app.js`)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /javascript/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('unsafe bind adds its origin to the CSP connect-src', async () => {
  const { server, port } = await startStatic('192.168.1.5')
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    assert.match(res.headers.get('content-security-policy'), /ws:\/\/192\.168\.1\.5:12345/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('traversal and dotfiles are rejected', async () => {
  const { server, port } = await startStatic()
  try {
    const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e%2f%2e%2e%2fpackage.json`)
    assert.equal(traversal.status, 404)
    const encoded = await fetch(`http://127.0.0.1:${port}/sub%2f..%2f..%2fpackage.json`)
    assert.equal(encoded.status, 404)
    const dotfile = await fetch(`http://127.0.0.1:${port}/.secret`)
    assert.equal(dotfile.status, 404)
    const nestedDotfile = await fetch(`http://127.0.0.1:${port}/sub/.env`)
    assert.equal(nestedDotfile.status, 404)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('only GET and HEAD are allowed', async () => {
  const { server, port } = await startStatic()
  try {
    const post = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET, HEAD')
    const head = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String('<!doctype html><title>ok</title>'.length))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('missing files are 404', async () => {
  const { server, port } = await startStatic()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope.txt`)
    assert.equal(res.status, 404)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
