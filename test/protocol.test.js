import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateClientMessage, normalizeComponentText, MAX_CHAT } from '../src/protocol.js'

test('valid messages pass validation', () => {
  const ok = [
    { t: 'sub', s: 'main@lobby' },
    { t: 'session.start', account: 'main', server: 'lobby' },
    { t: 'session.stop', s: 'alt@lobby' },
    { t: 'config.server.put', server: { id: 'lobby', host: 'play.example.net' } },
    { t: 'config.server.del', id: 'lobby' },
    { t: 'config.account.put', account: { id: 'main', auth: 'offline', username: 'Nick' } },
    { t: 'config.account.del', id: 'main' },
    { t: 'chat', s: 'main@lobby', text: 'hi' },
    { t: 'tab', s: 'main@lobby', text: '/ga' },
    { t: 'ctl', s: 'main@lobby', k: 'forward', on: true },
    { t: 'hold', s: 'main@lobby' },
    { t: 'look', s: 'main@lobby', yaw: 1.5, pitch: -0.2 },
    { t: 'lookAt', s: 'main@lobby', x: 1, y: 2, z: 3 },
    { t: 'goto', s: 'main@lobby', x: 10, z: -4 },
    { t: 'goto', s: 'main@lobby', x: 10, z: -4, y: 64 },
    { t: 'step', s: 'main@lobby', dir: 'n', n: 4 },
    { t: 'stop', s: 'main@lobby' },
    { t: 'interact', s: 'main@lobby' },
    { t: 'use', s: 'main@lobby' },
    { t: 'hotbar', s: 'main@lobby', i: 3 },
    { t: 'click', s: 'main@lobby', window: 1, slot: 5, button: 1, mode: 0 },
    { t: 'drop', s: 'main@lobby', slot: 36, all: false },
    { t: 'closeWindow', s: 'main@lobby' }
  ]
  for (const msg of ok) {
    const result = validateClientMessage(msg)
    assert.equal(result.ok, true, `${msg.t}: ${result.msg}`)
  }
})

test('bad messages are rejected with codes', () => {
  const bad = [
    [null, 'bad_message'],
    [[], 'bad_message'],
    [{}, 'bad_message'],
    [{ t: 42 }, 'bad_message'],
    [{ t: 'nope' }, 'unknown_type'],
    [{ t: 'sub' }, 'bad_field'],
    [{ t: 'sub', s: 'Bad Id!' }, 'bad_field'],
    [{ t: 'session.start', account: 'main', server: 'UPPER' }, 'bad_field'],
    [{ t: 'chat', s: 'main@lobby' }, 'bad_field'],
    [{ t: 'chat', s: 'main@lobby', text: 'x'.repeat(MAX_CHAT + 1) }, 'bad_field'],
    [{ t: 'ctl', s: 'main@lobby', k: 'fly', on: true }, 'bad_field'],
    [{ t: 'ctl', s: 'main@lobby', k: 'forward', on: 'yes' }, 'bad_field'],
    [{ t: 'look', s: 'main@lobby', yaw: NaN, pitch: 0 }, 'bad_field'],
    [{ t: 'lookAt', s: 'main@lobby', x: Infinity, y: 0, z: 0 }, 'bad_field'],
    [{ t: 'goto', s: 'main@lobby', x: 'far', z: 0 }, 'bad_field'],
    [{ t: 'step', s: 'main@lobby', dir: 'up', n: 1 }, 'bad_field'],
    [{ t: 'step', s: 'main@lobby', dir: 'n', n: 0 }, 'bad_field'],
    [{ t: 'hotbar', s: 'main@lobby', i: 9 }, 'bad_field'],
    [{ t: 'click', s: 'main@lobby', window: 1, slot: 5, button: 5, mode: 0 }, 'bad_field'],
    [{ t: 'click', s: 'main@lobby', window: 1, slot: 5, button: 0, mode: 4 }, 'bad_field'],
    [{ t: 'drop', s: 'main@lobby', slot: -1, all: false }, 'bad_field'],
    [{ t: 'drop', s: 'main@lobby', slot: 1, all: 'yes' }, 'bad_field'],
    [{ t: 'config.server.put', server: { id: 'Bad', host: 'x' } }, 'bad_field'],
    [{ t: 'config.server.put', server: { id: 'ok', host: '' } }, 'bad_field'],
    [{ t: 'config.account.put', account: { id: 'ok', auth: 'mojang', username: 'x' } }, 'bad_field']
  ]
  for (const [msg, code] of bad) {
    const result = validateClientMessage(msg)
    assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(msg)}`)
    assert.equal(result.code, code)
  }
})

test('config.server.put accepts an auto-login update without a password', () => {
  const result = validateClientMessage({
    t: 'config.server.put',
    server: { id: 'lobby', host: 'h', autoLogin: { trigger: '/(login)/i' } }
  })
  assert.equal(result.ok, true, result.msg)
})

test('normalizeComponentText handles strings, JSON, components and NBT', () => {
  const cases = [
    ['hello', 'hello'],
    ['{"text":"hi","extra":[{"text":"!"}]}', 'hi!'],
    [{ text: 'plain' }, 'plain'],
    [{ translate: 'multiplayer.disconnect.idling' }, 'multiplayer.disconnect.idling'],
    [{ type: 'string', value: 'scalar' }, 'scalar'],
    [{ type: 'compound', value: { text: { type: 'string', value: 'nbt text' } } }, 'nbt text'],
    [{ type: 'compound', value: { translate: { type: 'string', value: 'velocity.error.already-connected-proxy' } } }, 'velocity.error.already-connected-proxy']
  ]
  for (const [input, expected] of cases) {
    const result = normalizeComponentText(input, null)
    assert.equal(result.plain, expected, JSON.stringify(input))
  }
})

test('normalizeComponentText falls back to a chat parser but ignores empty output', () => {
  const result = normalizeComponentText({ type: 'compound', value: { translate: { type: 'string', value: 'x.y' } } }, () => '')
  assert.equal(result.plain, 'x.y')
})
