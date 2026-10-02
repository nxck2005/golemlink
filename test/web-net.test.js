import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { store } from '../web/store.js'
import { connect, tokenFromUrl } from '../web/net.js'

class FakeSocket {
  constructor () {
    this.readyState = 1
    this.listeners = new Map()
    this.sent = []
  }

  addEventListener (name, listener) { this.listeners.set(name, listener) }
  send (text) { this.sent.push(JSON.parse(text)) }
  receive (msg) { this.listeners.get('message')({ data: JSON.stringify(msg) }) }
}

const originalGlobals = new Map(['WebSocket', 'location', 'localStorage', 'history'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))

beforeEach(() => {
  globalThis.WebSocket = FakeSocket
  globalThis.location = { hash: '', protocol: 'http:', host: 'localhost:8765', pathname: '/', search: '' }
  const saved = new Map([['golemlink.token', 'test-token']])
  globalThis.localStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) }
  globalThis.history = { replaceState: () => { location.hash = '' } }
  store.setSession(null)
  store.sessions = []
  store.connected = false
  store.tokenRejected = false
  connect()
})

afterEach(() => {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

test('the first newly started session is selected and subscribed', () => {
  store.ws.receive({ t: 'hello', sessions: [] })
  store.ws.receive({ t: 'sessions', sessions: [{ id: 'main@lobby', state: 'connecting' }] })
  assert.equal(store.sessionId, 'main@lobby')
  assert.deepEqual(store.ws.sent.at(-1), { t: 'sub', s: 'main@lobby' })
})

test('removing the selected session subscribes to its replacement', () => {
  store.ws.receive({ t: 'hello', sessions: [{ id: 'a@one' }, { id: 'b@two' }] })
  store.ws.receive({ t: 'sessions', sessions: [{ id: 'b@two' }] })
  assert.equal(store.sessionId, 'b@two')
  assert.deepEqual(store.ws.sent.at(-1), { t: 'sub', s: 'b@two' })
})

test('inventory and map traffic from other subscriptions cannot corrupt the selected bot', () => {
  store.ws.receive({ t: 'hello', sessions: [{ id: 'a@one' }, { id: 'b@two' }] })
  store.ws.receive({ t: 'snapshot', s: 'a@one', inventory: { slots: [null] }, cursor: null })
  for (const msg of [
    { t: 'inv', window: 0, slots: { 0: { n: 'diamond', c: 1 } }, cursor: { n: 'stone' } },
    { t: 'window', window: { id: 5 } },
    { t: 'tiles', tiles: [{ cx: 1, cz: 2, rgb: 'foreign' }] }
  ]) store.ws.receive({ ...msg, s: 'b@two' })
  assert.deepEqual(store.inventory.slots, [null])
  assert.equal(store.cursor, null)
  assert.equal(store.window, undefined)
  assert.equal(store.tiles.size, 0)
  store.ws.receive({ t: 'tiles', s: 'a@one', tiles: [{ cx: 1, cz: 2, rgb: 'own' }] })
  store.ws.receive({ t: 'untile', s: 'b@two', tiles: [{ cx: 1, cz: 2 }] })
  assert.equal(store.tiles.get('1,2').rgb, 'own')
  store.ws.receive({ t: 'inv', s: 'a@one', window: 0, slots: { 0: { n: 'stone', c: 1 } }, cursor: null })
  assert.equal(store.inventory.slots[0].n, 'stone')
})

test('state updates preserve reconnect timing and clear completed sign-in prompts', () => {
  store.ws.receive({ t: 'hello', sessions: [{ id: 'a@one', state: 'connecting', pendingMsa: { code: 'ABCD' } }] })
  store.ws.receive({ t: 'state', s: 'a@one', state: 'reconnecting', retryInMs: 5000 })
  assert.equal(store.session().retryInMs, 5000)
  assert.equal(store.session().pendingMsa, undefined)
  store.ws.receive({ t: 'state', s: 'a@one', state: 'online' })
  assert.equal(store.session().retryInMs, undefined)
})

test('malformed token fragments do not crash startup or replace a saved token', () => {
  location.hash = '#t=%invalid'
  assert.equal(tokenFromUrl(), null)
  assert.equal(localStorage.getItem('golemlink.token'), 'test-token')
  assert.equal(location.hash, '')
})

test('a new token link overrides storage and removes the fragment', () => {
  location.hash = '#t=new%2Dtoken'
  assert.equal(tokenFromUrl(), 'new-token')
  assert.equal(localStorage.getItem('golemlink.token'), 'new-token')
  assert.equal(location.hash, '')
})
