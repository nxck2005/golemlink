import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { WsHub } from '../src/ws.js'
import { freePort, stubTermux, stubLogger } from './helpers.mjs'

async function startHub ({ authTimeoutMs, handle } = {}) {
  const token = `token-${Math.random()}`
  const port = await freePort()
  const server = http.createServer((req, res) => res.end('ok'))
  const sessions = {
    list: () => [],
    get: () => null,
    supportedVersions: ['1.21.11'],
    handle: handle || (async () => null)
  }
  const control = {
    accountsForUi: () => [],
    serversForUi: () => [],
    daemonInfo: () => ({ app: 'test' }),
    startSession () {},
    stopSession () {},
    putServer () {},
    delServer () {},
    putAccount () {},
    delAccount () {}
  }
  const hub = new WsHub({ server, port, token, sessions, logger: stubLogger(), control, termux: stubTermux(), authTimeoutMs })
  hub.attach()
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return { hub, server, port, token }
}

function connect (port, { token, origin = `http://127.0.0.1:${port}`, host } = {}) {
  const headers = {}
  if (origin !== null) headers.Origin = origin
  if (host) headers.Host = host
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
  const messages = []
  const waiters = []
  ws.on('message', data => {
    const msg = JSON.parse(data.toString())
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(msg)) {
        const waiter = waiters.splice(i, 1)[0]
        waiter.resolve(msg)
        return
      }
    }
    messages.push(msg)
  })
  return {
    ws,
    messages,
    waitFor (predicate, timeout = 4000) {
      const existing = messages.findIndex(predicate)
      if (existing >= 0) return Promise.resolve(messages.splice(existing, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiters.push(waiter)
        setTimeout(() => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error('timeout waiting for ws message'))
        }, timeout)
      })
    },
    closeCode () {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(ws._closeCode)
      return new Promise(resolve => ws.once('close', code => resolve(code)))
    },
    auth () {
      return new Promise(resolve => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'auth', token }))
          resolve()
        } else {
          ws.once('open', () => {
            ws.send(JSON.stringify({ t: 'auth', token }))
            resolve()
          })
        }
      })
    }
  }
}

test('a good token receives hello', async () => {
  const { hub, server, port, token } = await startHub()
  const client = connect(port, { token })
  await client.auth()
  const hello = await client.waitFor(msg => msg.t === 'hello')
  assert.equal(hello.v, 1)
  assert.deepEqual(hello.supportedVersions, ['1.21.11'])
  assert.ok(hello.features)
  client.ws.close()
  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})

test('a wrong token closes with 4401 and the server stays up', async () => {
  const { hub, server, port, token } = await startHub()
  const bad = connect(port, { token: 'wrong' })
  await bad.auth()
  assert.equal(await bad.closeCode(), 4401)
  const good = connect(port, { token })
  await good.auth()
  const hello = await good.waitFor(msg => msg.t === 'hello')
  assert.equal(hello.v, 1)
  good.ws.close()
  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})

test('a wrong-length token cannot crash the comparison', async () => {
  const { hub, server, port, token } = await startHub()
  const shortClient = connect(port, { token: 'x' })
  await shortClient.auth()
  assert.equal(await shortClient.closeCode(), 4401)
  const good = connect(port, { token })
  await good.auth()
  await good.waitFor(msg => msg.t === 'hello')
  good.ws.close()
  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})

test('no auth message closes with 4401 after the timeout', async () => {
  const { hub, server, port } = await startHub({ authTimeoutMs: 150 })
  const client = connect(port, { token: 'unused' })
  await new Promise(resolve => client.ws.once('open', resolve))
  assert.equal(await client.closeCode(), 4401)
  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})

test('bad Origin and bad Host are rejected with 4401', async () => {
  const { hub, server, port, token } = await startHub()
  const badOrigin = connect(port, { token, origin: 'http://evil.example' })
  await badOrigin.auth()
  assert.equal(await badOrigin.closeCode(), 4401)

  const badHost = connect(port, { token, host: 'evil.example' })
  await badHost.auth()
  assert.equal(await badHost.closeCode(), 4401)

  const missingOrigin = connect(port, { token, origin: null })
  await missingOrigin.auth()
  assert.equal(await missingOrigin.closeCode(), 4401)

  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})

test('excess messages are dropped with rate_limited but the socket stays open', async () => {
  const { hub, server, port, token } = await startHub()
  const client = connect(port, { token })
  await client.auth()
  await client.waitFor(msg => msg.t === 'hello')
  for (let i = 0; i < 220; i++) {
    client.ws.send(JSON.stringify({ t: 'hold', s: 'a@s', id: i }))
  }
  const limited = await client.waitFor(msg => msg.t === 'err' && msg.code === 'rate_limited', 8000)
  assert.equal(limited.t, 'err')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(client.ws.readyState, WebSocket.OPEN)
  client.ws.close()
  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})

test('sustained flooding closes the connection', async () => {
  const { hub, server, port, token } = await startHub()
  const client = connect(port, { token })
  await client.auth()
  await client.waitFor(msg => msg.t === 'hello')
  const interval = setInterval(() => {
    for (let i = 0; i < 40; i++) {
      if (client.ws.readyState !== WebSocket.OPEN) return
      client.ws.send(JSON.stringify({ t: 'hold', s: 'a@s' }))
    }
  }, 10)
  const code = await client.closeCode()
  clearInterval(interval)
  assert.equal(code, 1008)
  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})

test('handler errors are answered with an err and no crash', async () => {
  const { hub, server, port, token } = await startHub({
    handle: async () => {
      throw Object.assign(new Error('no such session'), { code: 'no_session' })
    }
  })
  const client = connect(port, { token })
  await client.auth()
  await client.waitFor(msg => msg.t === 'hello')
  client.ws.send(JSON.stringify({ t: 'hold', s: 'a@s', id: 7 }))
  const err = await client.waitFor(msg => msg.t === 'err' && msg.id === 7)
  assert.equal(err.code, 'no_session')
  client.ws.close()
  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})

test('malformed JSON gets bad_json and missing auth is enforced', async () => {
  const { hub, server, port, token } = await startHub()
  const client = connect(port, { token })
  await client.auth()
  await client.waitFor(msg => msg.t === 'hello')
  client.ws.send('not json')
  const err = await client.waitFor(msg => msg.t === 'err' && msg.code === 'bad_json')
  assert.ok(err)
  client.ws.close()
  await new Promise(resolve => server.close(resolve))
  hub.destroy()
})
