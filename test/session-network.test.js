import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { startFakeServer } from '../scripts/fake-server.mjs'
import { makeSession, stubHub, waitUntil, freePort, stubManager, stubLogger } from './helpers.mjs'

const MC_VERSION = process.env.MC_VERSION || '1.21.11'

function serverConfig (port, extra = {}) {
  return { id: 'srv', name: 'srv', host: '127.0.0.1', port, version: MC_VERSION, autoReconnect: false, chatLog: false, ...extra }
}

test('clients subscribed while connecting receive a complete inventory snapshot on spawn', async () => {
  const fake = await startFakeServer({ version: MC_VERSION })
  const hub = stubHub()
  const session = makeSession({ hub, server: serverConfig(fake.port) })
  try {
    session.start()
    await waitUntil(() => session.state === 'connecting')
    const connecting = session.snapshot()
    assert.equal(connecting.inventory, null)
    session.onSubscribed()
    await waitUntil(() => session.state === 'online', { timeout: 15000, label: 'online' })
    const snapshot = hub.sent.find(entry => entry.msg.t === 'snapshot' && entry.msg.state === 'online')?.msg
    assert.ok(snapshot, 'spawn must resync clients that subscribed before inventory was attached')
    assert.equal(snapshot.inventory.id, 0)
    assert.equal(snapshot.inventory.slots.length, session.bot.inventory.slots.length)
    assert.ok(snapshot.inventory.slots.length >= 45)
    assert.ok(snapshot.status)
  } finally {
    session.destroy()
    await fake.stop()
  }
})

test('spawning cancels the connection timeout and late connect events cannot rearm it', async () => {
  const fake = await startFakeServer({ version: MC_VERSION })
  const session = makeSession({ server: serverConfig(fake.port), noSpawnMs: 1500 })
  try {
    session.start()
    await waitUntil(() => session.state === 'online', { timeout: 10000, label: 'online' })
    assert.equal(session.noSpawnTimer, null, 'spawn must cancel the connection deadline')
    session.bot.emit('connect')
    assert.equal(session.noSpawnTimer, null, 'late connect events must not arm an online bot timeout')
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal(session.state, 'online', 'a spawned bot must survive past its connection deadline')
  } finally {
    session.destroy()
    await fake.stop()
  }
})

test('settling: a refused connection settles once with a network reason', async () => {
  const port = await freePort()
  const hub = stubHub()
  const session = makeSession({ hub, server: serverConfig(port), noSpawnMs: 2000 })
  session.start()
  await waitUntil(() => session.state === 'stopped', { timeout: 10000, label: 'stopped' })
  assert.match(session.reason, /network/)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(hub.states().filter(s => s.state === 'stopped').length, 1, 'exactly one settle')
  session.destroy()
})

test('settling: error then end still settles once', async () => {
  const port = await freePort()
  const hangup = net.createServer(socket => socket.destroy())
  await new Promise(resolve => hangup.listen(port, '127.0.0.1', resolve))
  const hub = stubHub()
  const session = makeSession({ hub, server: serverConfig(port), noSpawnMs: 2000 })
  session.start()
  await waitUntil(() => session.state === 'stopped', { timeout: 10000, label: 'stopped' })
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(hub.states().filter(s => s.state === 'stopped').length, 1)
  assert.match(session.reason, /network|disconnected/)
  session.destroy()
  hangup.close()
})

test('settling: kick then end settles once with the kick reason', async () => {
  const fake = await startFakeServer({ version: MC_VERSION })
  try {
    const session = makeSession({ hub: stubHub(), server: serverConfig(fake.port) })
    session.start()
    await waitUntil(() => session.state === 'online', { timeout: 15000, label: 'online' })
    fake.kickText('Kicked for testing')
    await waitUntil(() => session.state === 'stopped', { timeout: 8000, label: 'stopped' })
    assert.match(session.reason, /kicked/)
    session.destroy()
  } finally {
    await fake.stop()
  }
})

test('settling: 30 s no-spawn timer (shortened) and pause for a device code', async () => {
  const fake = await startFakeServer({ version: MC_VERSION, sendHealth: false })
  try {
    const session = makeSession({ hub: stubHub(), server: serverConfig(fake.port), noSpawnMs: 400 })
    session.start()
    await waitUntil(() => session.state === 'connecting', { timeout: 5000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    session.handleMsaCode({ userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/link', expiresIn: 900 })
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.equal(session.state, 'connecting', 'timer must be paused for a pending device code')
    assert.equal(session.pendingMsa.code, 'ABCD-EFGH')
    session.armNoSpawnTimer()
    await waitUntil(() => session.state === 'stopped', { timeout: 3000, label: 'timeout stop' })
    assert.match(session.detail || '', /timed out/)
    session.destroy()
  } finally {
    await fake.stop()
  }
})

test('session isolation: throws in one session never take down another', async () => {
  const fake = await startFakeServer({ version: MC_VERSION })
  const hub = stubHub()
  const manager = stubManager()
  const logger = stubLogger()
  const sessions = ['one', 'two', 'three'].map(name => makeSession({
    hub,
    manager,
    account: { id: name, auth: 'offline', username: `Iso${name}` },
    server: serverConfig(fake.port)
  }))
  // give each session its own logger but the same stubs
  try {
    for (const session of sessions) session.start()
    await waitUntil(() => sessions.every(s => s.state === 'online'), { timeout: 25000, label: 'three sessions online' })

    // 1. a throw in a physicsTick listener ends only that session
    sessions[0].bot.on('physicsTick', () => {
      throw new Error('boom in physicsTick')
    })
    await waitUntil(() => sessions[0].state === 'stopped', { timeout: 5000, label: 'first session stopped' })
    assert.match(sessions[0].reason, /internal/)
    assert.equal(sessions[1].state, 'online')
    assert.equal(sessions[2].state, 'online')

    // 2. a throw in a packet handler ends only that session
    sessions[1].bot._client.on('update_time', () => {
      throw new Error('boom in packet handler')
    })
    sessions[1].bot._client.emit('update_time', { age: 0n, time: 0n, tickDayTime: true })
    await waitUntil(() => sessions[1].state === 'stopped', { timeout: 5000, label: 'second session stopped' })
    assert.match(sessions[1].reason, /internal/)
    assert.equal(sessions[2].state, 'online')
    logger.lines.length // silence unused warning
  } finally {
    for (const session of sessions) session.destroy()
    await fake.stop()
  }
})
