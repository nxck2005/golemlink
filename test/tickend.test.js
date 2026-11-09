import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { TickEnd, sendsTickEnd } from '../src/tickend.js'
import { testRegistry } from './helpers.mjs'

function fakeBot ({ version = '1.21.11', state = 'play', write } = {}) {
  const registry = testRegistry(version)
  const written = []
  return {
    written,
    supportFeature: name => registry.supportFeature(name),
    _client: {
      state,
      write: write || ((name, params) => written.push([name, params]))
    }
  }
}

function clock () {
  let t = 1000
  return { now: () => t, advance: ms => { t += ms } }
}

test('tick_end is sent from 1.21.2 on and not before', () => {
  assert.equal(sendsTickEnd(fakeBot({ version: '1.21.11' })), true)
  assert.equal(sendsTickEnd(fakeBot({ version: '26.1' })), true)
  assert.equal(sendsTickEnd(fakeBot({ version: '1.21.1' })), false)
  assert.equal(sendsTickEnd(fakeBot({ version: '1.8.8' })), false)
  assert.equal(sendsTickEnd({}), false, 'a bot without supportFeature never sends it')

  const old = new TickEnd({ bot: fakeBot({ version: '1.20.4' }) })
  assert.equal(old.start(), false)
  assert.equal(old.timer, null)
})

test('one tick_end per 50 ms of elapsed time, keeping the remainder', () => {
  const c = clock()
  const bot = fakeBot()
  const tickEnd = new TickEnd({ bot, now: c.now })
  tickEnd.last = c.now()
  c.advance(50)
  assert.equal(tickEnd.tick(), 1)
  c.advance(120)
  assert.equal(tickEnd.tick(), 2)
  c.advance(30) // 20 left over + 30
  assert.equal(tickEnd.tick(), 1)
  c.advance(10)
  assert.equal(tickEnd.tick(), 0)
  assert.equal(bot.written.length, 4)
  assert.deepEqual(bot.written[0], ['tick_end', {}])
})

test('a late timer catches up at most four ticks at a time, like mineflayer physics', () => {
  const c = clock()
  const bot = fakeBot()
  const tickEnd = new TickEnd({ bot, now: c.now })
  tickEnd.last = c.now()
  c.advance(500)
  assert.equal(tickEnd.tick(), 4)
  c.advance(50) // 300 owed + 50
  assert.equal(tickEnd.tick(), 4)
  c.advance(50) // 150 owed + 50
  assert.equal(tickEnd.tick(), 4)
  c.advance(50)
  assert.equal(tickEnd.tick(), 1)
  assert.equal(bot.written.length, 13)
})

test('no tick_end outside the play state, and those ticks are dropped', () => {
  const c = clock()
  const bot = fakeBot({ state: 'configuration' })
  const tickEnd = new TickEnd({ bot, now: c.now })
  tickEnd.last = c.now()
  c.advance(400)
  assert.equal(tickEnd.tick(), 0)
  bot._client.state = 'play'
  c.advance(50)
  assert.equal(tickEnd.tick(), 1, 'ticks from the configuration phase must not be sent afterwards')
  assert.equal(bot.written.length, 1)
})

test('a failing write stops the timer and reports instead of throwing', () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const c = clock()
    const errors = []
    const bot = fakeBot({ write: () => { throw new Error('socket closed') } })
    const tickEnd = new TickEnd({ bot, now: c.now, onError: err => errors.push(err.message) })
    assert.equal(tickEnd.start(), true)
    assert.equal(tickEnd.start(), false, 'starting twice keeps one timer')
    c.advance(50)
    mock.timers.tick(50)
    assert.deepEqual(errors, ['socket closed'])
    assert.equal(tickEnd.timer, null)
  } finally {
    mock.timers.reset()
  }
})
