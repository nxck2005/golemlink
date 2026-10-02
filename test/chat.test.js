import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateChatText, messageToSegs, makeChatMessage, ChatLog } from '../src/chat.js'
import { testRegistry } from './helpers.mjs'

const registry = testRegistry('1.21.11')

test('chat length limits by version', () => {
  assert.equal(validateChatText('x'.repeat(256)).ok, true)
  assert.equal(validateChatText('x'.repeat(257)).ok, false)
  assert.equal(validateChatText('x'.repeat(100), { oldLimit: true }).ok, true)
  assert.equal(validateChatText('x'.repeat(101), { oldLimit: true }).ok, false)
  assert.equal(validateChatText('x'.repeat(101)).ok, true)
})

test('chat rejects section signs, control characters and newlines', () => {
  assert.equal(validateChatText('§c red').ok, false)
  assert.equal(validateChatText('line\nbreak').ok, false)
  assert.equal(validateChatText('bell\u0007').ok, false)
  assert.equal(validateChatText('del\u007f').ok, false)
  assert.equal(validateChatText('ok\u00a7').ok, false)
  assert.equal(validateChatText('').ok, false)
})

test('segments: text, named and hex colors, flags and inheritance', () => {
  const simple = messageToSegs(makeChatMessage({ text: 'hello' }, registry), registry.language)
  assert.equal(simple.plain, 'hello')
  assert.deepEqual(simple.segs, [{ x: 'hello' }])

  const colored = messageToSegs(makeChatMessage({ text: 'red', color: 'red' }, registry), registry.language)
  assert.equal(colored.segs[0].c, '#ff5555')

  const hex = messageToSegs(makeChatMessage({ text: 'x', color: '#123456' }, registry), registry.language)
  assert.equal(hex.segs[0].c, '#123456')

  const styled = messageToSegs(makeChatMessage({ text: 'a', color: 'gold', bold: true, extra: [{ text: 'b', italic: true }] }, registry), registry.language)
  assert.equal(styled.segs[0].c, '#ffaa00')
  assert.equal(styled.segs[0].b, 1)
  assert.equal(styled.segs[1].c, '#ffaa00') // inherited
  assert.equal(styled.segs[1].i, 1)
  assert.equal(styled.plain, 'ab')
})

test('translations are resolved and keep with-arguments', () => {
  const message = makeChatMessage({ translate: 'chat.type.text', with: [{ text: 'Nick' }, { text: 'hi there' }] }, registry)
  const { plain, segs } = messageToSegs(message, registry.language)
  assert.ok(plain.includes('Nick'), plain)
  assert.ok(plain.includes('hi there'), plain)
  assert.ok(segs.length >= 1)
})

test('password redaction covers plain text, segments and the JSONL log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-chat-'))
  const log = new ChatLog({ sessionId: 'a@s', dataDir: dir, chatLog: true, registry, logger: { warn () {} } })
  log.setPasswords(['hunter2'])
  const line = log.add(makeChatMessage('my password is hunter2 ok', registry), 'chat', 'Nick')
  assert.equal(line.plain, 'my password is •••• ok')
  assert.ok(line.segs.every(seg => !seg.x.includes('hunter2')))
  assert.ok(log.backlog()[0].plain.includes('••••'))
  const files = fs.readdirSync(path.join(dir, 'logs', 'a@s'))
  assert.equal(files.length, 1)
  const content = fs.readFileSync(path.join(dir, 'logs', 'a@s', files[0]), 'utf8')
  assert.ok(!content.includes('hunter2'))
  assert.ok(content.includes('••••'))
})

test('backlog keeps the last 500 lines', () => {
  const log = new ChatLog({ sessionId: 'a@s', dataDir: '/tmp/nope-not-used', chatLog: false, registry, logger: { warn () {} } })
  for (let i = 0; i < 510; i++) log.add(makeChatMessage(`line ${i}`, registry), 'chat', null)
  const backlog = log.backlog()
  assert.equal(backlog.length, 500)
  assert.equal(backlog[0].plain, 'line 10')
})
