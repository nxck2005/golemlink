import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Board, expandLegacy } from '../src/board.js'
import { chatClass } from '../src/chat.js'
import { testRegistry } from './helpers.mjs'

const registry = testRegistry('1.21.11')
const ChatMessage = chatClass(registry)

const nbtText = (text, color) => ({
  type: 'compound',
  name: '',
  value: { text: { type: 'string', value: text }, ...(color ? { color: { type: 'string', value: color } } : {}) }
})

function fakeBot () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.username = 'golem'
  bot.teamMap = {}
  bot.bossBars = []
  bot.tablist = { header: new ChatMessage(''), footer: new ChatMessage('') }
  return bot
}

function board (bot = fakeBot()) {
  const sent = []
  const b = new Board({ bot, send: payload => sent.push(payload), intervalMs: 60 * 60 * 1000 })
  b.attach()
  return { bot, b, sent }
}

const text = segs => segs.map(seg => seg.x).join('')

test('legacy colour codes inside text become segments', () => {
  assert.deepEqual(expandLegacy([{ x: '§eBalance: §6$12' }]), [{ c: '#ffff55', x: 'Balance: ' }, { c: '#ffaa00', x: '$12' }])
  assert.deepEqual(expandLegacy([{ x: 'a§lb§rc', c: '#55ff55' }]), [{ c: '#55ff55', x: 'a' }, { c: '#55ff55', b: 1, x: 'b' }, { x: 'c' }])
  assert.deepEqual(expandLegacy([{ x: '§a§r' }]), [])
})

test('the sidebar comes from raw 1.20.3+ packets, sorted like vanilla', () => {
  const { bot, b } = board()
  bot._client.emit('scoreboard_objective', { name: 'side', action: 0, displayText: nbtText('SURVIVAL', 'yellow'), type: 0 })
  bot._client.emit('scoreboard_display_objective', { position: 1, name: 'side' })
  bot._client.emit('scoreboard_score', { itemName: 'b', scoreName: 'side', value: 2 })
  bot._client.emit('scoreboard_score', { itemName: 'a', scoreName: 'side', value: 2 })
  bot._client.emit('scoreboard_score', { itemName: '§eKills', scoreName: 'side', value: 9 })
  const sidebar = b.payload().sidebar
  assert.deepEqual(sidebar.title, [{ x: 'SURVIVAL', c: '#ffff55' }])
  assert.deepEqual(sidebar.lines.map(line => text(line.segs)), ['Kills', 'a', 'b'])
  assert.equal(sidebar.lines[0].segs[0].c, '#ffff55')
  assert.equal(sidebar.lines[0].score, '9')

  bot._client.emit('reset_score', { entity_name: 'a', objective_name: 'side' })
  assert.deepEqual(b.payload().sidebar.lines.map(line => text(line.segs)), ['Kills', 'b'])
  bot._client.emit('scoreboard_objective', { name: 'side', action: 1 })
  assert.equal(b.payload().sidebar, null)
})

test('number formats hide, restyle or replace the score', () => {
  const { bot, b } = board()
  bot._client.emit('scoreboard_objective', { name: 's', action: 0, displayText: nbtText('T'), type: 0, number_format: 0 })
  bot._client.emit('scoreboard_display_objective', { position: 1, name: 's' })
  bot._client.emit('scoreboard_score', { itemName: 'hidden', scoreName: 's', value: 3 })
  bot._client.emit('scoreboard_score', { itemName: 'fixed', scoreName: 's', value: 2, number_format: 2, styling: nbtText('MAX', 'gold') })
  bot._client.emit('scoreboard_score', { itemName: 'styled', scoreName: 's', value: 1, number_format: 1, styling: nbtText('', 'green'), display_name: nbtText('Shown name', 'aqua') })
  const [hidden, fixed, styled] = b.payload().sidebar.lines
  assert.equal(hidden.score, undefined)
  assert.equal(hidden.scoreSegs, undefined)
  assert.deepEqual(fixed.scoreSegs, [{ x: 'MAX', c: '#ffaa00' }])
  assert.equal(styled.score, '1')
  assert.equal(styled.sc, '#55ff55')
  assert.deepEqual(styled.segs, [{ x: 'Shown name', c: '#55ffff' }])
})

test('scoreboard lines take the team prefix and suffix', () => {
  const { bot, b } = board()
  bot.teamMap['§1'] = { displayName: member => new ChatMessage({ text: '', extra: [{ text: 'Balance: ', color: 'white' }, { text: member }, { text: '$40', color: 'gold' }] }) }
  bot._client.emit('scoreboard_objective', { name: 's', action: 0, displayText: nbtText('T'), type: 0 })
  bot._client.emit('scoreboard_display_objective', { position: 1, name: 's' })
  bot._client.emit('scoreboard_score', { itemName: '§1', scoreName: 's', value: 1 })
  assert.equal(text(b.payload().sidebar.lines[0].segs), 'Balance: $40')
})

test('boss bars and the tab list are included, and unchanged boards are not resent', () => {
  const { bot, b, sent } = board()
  bot.bossBars = [{ entityUUID: 'u1', title: new ChatMessage({ text: 'Dragon', color: 'light_purple' }), health: 0.68, color: 'purple' }]
  bot.tablist.header = new ChatMessage({ text: 'Welcome\nplay.example.net', color: 'gold' })
  b.flush()
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].bars, [{ id: 'u1', segs: [{ x: 'Dragon', c: '#ff55ff' }], health: 0.68, color: 'purple' }])
  assert.equal(text(sent[0].tab.header), 'Welcome\nplay.example.net')
  bot.emit('bossBarUpdated')
  b.flush()
  assert.equal(sent.length, 1)
  bot.bossBars[0].health = 0.5
  bot.emit('bossBarUpdated')
  b.flush()
  assert.equal(sent.length, 2)
  b.detach()
  assert.equal(bot._client.listenerCount('scoreboard_score'), 0)
})
