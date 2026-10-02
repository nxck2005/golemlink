import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Alerts, compileKeyword } from '../src/alerts.js'
import { stubTermux, stubLogger } from './helpers.mjs'

function makeAlerts (server = {}) {
  const sent = []
  const alerts = new Alerts({
    sessionId: 'a@s',
    serverId: 's',
    server: { alerts: { keywords: ['Nick'], damage: true, death: true }, ...server },
    termux: stubTermux(),
    logger: stubLogger(),
    broadcast: msg => sent.push(msg)
  })
  return { alerts, sent }
}

test('keyword matching is whole-word and case-insensitive', () => {
  assert.equal(compileKeyword('Nick').test('nick is here'), true)
  assert.equal(compileKeyword('Nick').test('NickAlt joined the game'), false)
  assert.equal(compileKeyword('/n.ck/i').test('NACK'), true)
  const { alerts, sent } = makeAlerts()
  alerts.botUsername = 'Bot'
  alerts.chat({ plain: 'Nick joined the game', segs: [] }, 'Server')
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Nick/)
  assert.equal(sent[0].kind, 'keyword')
})

test('keyword alerts skip the bot own lines and recent sends', () => {
  const { alerts, sent } = makeAlerts()
  alerts.botUsername = 'Bot'
  alerts.chat({ plain: 'Nick says hi', segs: [], echo: true }, null) // echo
  alerts.chat({ plain: 'Bot: Nick is here', segs: [] }, 'Bot') // own sender
  alerts.noteSent('Nick is here')
  alerts.chat({ plain: 'Server: Nick is here', segs: [] }, null) // recent send text
  assert.equal(sent.length, 0)
  alerts.chat({ plain: 'Nick joined the game', segs: [] }, 'Other')
  assert.equal(sent.length, 1)
})

test('damage alerts have a 15 s cooldown', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
  try {
    const { alerts, sent } = makeAlerts()
    alerts.damage(20, 18)
    assert.equal(sent.length, 1)
    alerts.damage(18, 16)
    assert.equal(sent.length, 1)
    mock.timers.tick(15001)
    alerts.damage(16, 14)
    assert.equal(sent.length, 2)
  } finally {
    mock.timers.reset()
  }
})

test('alerts are rate limited per kind with coalesced counts', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
  try {
    const { alerts, sent } = makeAlerts()
    alerts.fire('keyword', 'one')
    alerts.fire('keyword', 'two')
    alerts.fire('keyword', 'three')
    assert.equal(sent.length, 1)
    mock.timers.tick(10001)
    assert.equal(sent.length, 2)
    assert.match(sent[1].text, /\(×2\)/)
  } finally {
    mock.timers.reset()
  }
})

test('death, stopped and msa map to their kinds', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
  try {
    const { alerts, sent } = makeAlerts()
    alerts.death()
    alerts.stopped('idle', 'reason text')
    alerts.msa('ABCD', 'https://microsoft.com/link')
    assert.deepEqual(sent.map(s => s.kind), ['death', 'stopped', 'msa'])
    assert.match(sent[2].text, /ABCD/)
  } finally {
    mock.timers.reset()
  }
})
