import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSession, testRegistry, stubHub } from './helpers.mjs'

const registry = testRegistry('1.21.11')
const fakeBot = { registry }

function classify (session, kind, data) {
  return session.classify(kind, data, fakeBot)
}

test('classification fixtures: duplicate login shapes', () => {
  const session = makeSession()
  const json = classify(session, 'kicked', '{"translate":"multiplayer.disconnect.duplicate_login"}')
  assert.equal(json.action, 'stop')
  assert.equal(json.reason, 'duplicate_login')

  const plain = classify(session, 'kicked', 'You logged in from another location')
  assert.equal(plain.reason, 'duplicate_login')

  const velocity = classify(session, 'kicked', {
    type: 'compound',
    value: { translate: { type: 'string', value: 'velocity.error.already-connected-proxy' } }
  })
  assert.equal(velocity.reason, 'duplicate_login')

  const bungee = classify(session, 'kicked', 'You are already connected to this server!')
  assert.equal(bungee.reason, 'duplicate_login')
})

test('classification fixtures: idle, bans and whitelists', () => {
  const session = makeSession()
  assert.equal(classify(session, 'kicked', '{"translate":"multiplayer.disconnect.idling"}').reason, 'idle')
  assert.equal(classify(session, 'kicked', 'You have been idle for too long!').reason, 'idle')
  assert.equal(classify(session, 'kicked', 'AFK check').reason, 'idle')
  assert.equal(classify(session, 'kicked', {
    type: 'compound',
    value: { text: { type: 'string', value: 'You are banned from this server' } }
  }).reason, 'banned')
  assert.equal(classify(session, 'kicked', '{"translate":"multiplayer.disconnect.not_whitelisted"}').reason, 'not_whitelisted')
})

test('classification fixtures: version and modded servers', () => {
  const session = makeSession()
  const outdated = classify(session, 'kicked', '{"translate":"multiplayer.disconnect.outdated_client"}')
  assert.equal(outdated.action, 'stop')
  assert.equal(outdated.reason, 'version')
  assert.match(outdated.detail, /1\.8\.8/)
  assert.match(outdated.detail, /ViaVersion/)

  assert.equal(classify(session, 'error', new Error("Unsupported protocol version '777'; try updating your packages with 'npm update'")).reason, 'version')
  assert.equal(classify(session, 'error', new Error('No data available for version 26.3')).reason, 'version')
  assert.equal(classify(session, 'error', new Error('This server is version 26.3, you are using version auto, please specify the correct version in the options.')).reason, 'version')
  assert.equal(classify(session, 'kicked', 'This server has NeoForge installed').reason, 'modded')
})

test('classification fixtures: auth, shutdown, network and unknown kicks', () => {
  const session = makeSession()
  assert.equal(classify(session, 'error', new Error('Failed to verify username!')).reason, 'auth')
  const shutdown = classify(session, 'kicked', '{"translate":"multiplayer.disconnect.server_shutdown"}')
  assert.equal(shutdown.action, 'reconnect')
  assert.equal(shutdown.reason, 'shutdown')
  assert.equal(shutdown.kick, false)

  const network = classify(session, 'error', new Error('connect ECONNREFUSED 127.0.0.1:1'))
  assert.equal(network.action, 'reconnect')
  assert.equal(network.reason, 'network')

  const end = classify(session, 'end', 'socketClosed')
  assert.equal(end.action, 'reconnect')
  assert.equal(end.reason, 'disconnected')

  const unknown = classify(session, 'kicked', { text: 'Kicked for a bit' })
  assert.equal(unknown.action, 'reconnect')
  assert.equal(unknown.reason, 'kicked')
  assert.equal(unknown.kick, true)

  const internal = classify(session, 'internal', new Error('boom'))
  assert.equal(internal.action, 'reconnect')
  assert.equal(internal.reason, 'internal')
  assert.equal(internal.kick, true)

  const stop = classify(session, 'stop', 'catchall')
  assert.equal(stop.action, 'stop')
  assert.equal(stop.reason, 'catchall')
})

test('backoff doubles from 5 s to 5 min', () => {
  const session = makeSession({ server: { id: 's', host: 'h', autoReconnect: true, chatLog: false } })
  const originalRandom = Math.random
  Math.random = () => 0.5
  try {
    const seen = []
    for (let i = 0; i < 9; i++) {
      session.applyOutcome({ action: 'reconnect', reason: 'network', detail: null, kick: false })
      seen.push(session.backoffMs)
      clearTimeout(session.reconnectTimer)
    }
    assert.deepEqual(seen, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000])
  } finally {
    Math.random = originalRandom
  }
})

test('the kick-loop breaker stops the third kick within 30 minutes', () => {
  const hub = stubHub()
  const session = makeSession({ hub, server: { id: 's', host: 'h', autoReconnect: true, chatLog: false } })
  session.applyOutcome({ action: 'reconnect', reason: 'kicked', detail: 'x', kick: true })
  assert.equal(session.state, 'reconnecting')
  clearTimeout(session.reconnectTimer)
  session.applyOutcome({ action: 'reconnect', reason: 'kicked', detail: 'x', kick: true })
  assert.equal(session.state, 'reconnecting')
  clearTimeout(session.reconnectTimer)
  session.applyOutcome({ action: 'reconnect', reason: 'kicked', detail: 'x', kick: true })
  assert.equal(session.state, 'stopped')
  assert.equal(session.reason, 'kick_loop')
})

test('duplicate login stops even with auto-reconnect on', () => {
  const hub = stubHub()
  const session = makeSession({ hub, server: { id: 's', host: 'h', autoReconnect: true, chatLog: false } })
  const outcome = classify(session, 'kicked', '{"translate":"multiplayer.disconnect.duplicate_login"}')
  session.applyOutcome(outcome)
  assert.equal(session.state, 'stopped')
  assert.equal(session.reason, 'duplicate_login')
  assert.equal(session.reconnectTimer, undefined)
})

test('states are reported to subscribers and sessions list', () => {
  const hub = stubHub()
  const session = makeSession({ hub })
  session.setState('connecting', { reason: null, detail: null })
  session.setState('online', { reason: null, detail: null })
  const states = hub.states()
  assert.deepEqual(states.map(s => s.state), ['connecting', 'online'])
  assert.equal(session.info().id, 'acct@srv')
})

test('features expose goto/click modes and termux availability', () => {
  const session = makeSession()
  const features = session.features()
  assert.deepEqual(features.clickModes, ['normal', 'shift'])
  assert.equal(features.goto, false)
  assert.equal(features.tabComplete, true)
})

test('server echoes of our own chat are not duplicated', () => {
  const hub = stubHub()
  const session = makeSession({ hub })
  const sent = []
  session.bot = { username: 'Bot', registry, supportFeature: () => false, chat: text => sent.push(text) }
  session.state = 'online'
  session.sendChat('hello world')
  // modern servers echo player chat without a sender name: match exact text
  session.handleMessage('hello world', 'chat', null)
  assert.equal(session.chatLog.backlog().length, 1, 'own echo must not be logged twice')
  const chats = hub.sent.map(entry => entry.msg).filter(msg => msg && msg.t === 'chat')
  assert.equal(chats.length, 1)
  session.handleMessage('someone else says hi', 'chat', null)
  assert.equal(session.chatLog.backlog().length, 2)
})

test('auto-login fires once per connection and the echo is redacted', () => {
  const hub = stubHub()
  const session = makeSession({
    hub,
    server: {
      id: 's',
      host: 'h',
      autoReconnect: false,
      chatLog: false,
      autoLogin: { password: 'hunter2', trigger: '/(login|log in)/i' }
    }
  })
  const sent = []
  session.bot = { username: 'Bot', registry, supportFeature: () => false, chat: text => sent.push(text) }
  session.state = 'online'
  session.autoLogin = {
    trigger: session.compileAutoLogin('/(login|log in)/i'),
    sent: false,
    password: 'hunter2'
  }
  session.handleMessage('Please log in to the server', 'chat', null)
  session.handleMessage('Please log in to the server', 'chat', null)
  assert.deepEqual(sent, ['/login hunter2'], 'once per connection')
  const echoes = session.chatLog.backlog().filter(line => line.echo)
  assert.equal(echoes.length, 1)
  assert.match(echoes[0].plain, /••••/)
  assert.ok(!JSON.stringify(echoes).includes('hunter2'))
})
