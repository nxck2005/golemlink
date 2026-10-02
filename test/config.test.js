import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validateConfig, validateServer, validateAccount, loadConfig, saveConfig,
  ensureDataDir, loadOrCreateToken, tokenPath, assertNotSharedStorage, resolveDataDir,
  applyServerUpdate, sanitizeServer, ID_RE
} from '../src/config.js'

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-cfg-'))
}

test('id pattern', () => {
  for (const good of ['a', 'main', 'alt_2', 'my-server', 'x'.repeat(32)]) assert.match(good, ID_RE)
  for (const bad of ['', 'Upper', 'has space', 'x'.repeat(33), 'dot.name', 'sl/ash']) assert.doesNotMatch(bad, ID_RE)
})

test('validateConfig fills defaults and reports errors', () => {
  const { config, errors } = validateConfig({
    accounts: [{ id: 'main', auth: 'offline', username: 'Nick' }],
    servers: [{ id: 'lobby', host: 'play.example.net' }]
  })
  assert.equal(errors.length, 0)
  assert.equal(config.version, 1)
  assert.equal(config.http.port, 8765)
  assert.equal(config.servers[0].port, 25565)
  assert.equal(config.servers[0].version, 'auto')
  assert.equal(config.servers[0].autoReconnect, true)
  assert.equal(config.servers[0].chatLog, true)
  assert.deepEqual(config.servers[0].antiAfk, { enabled: false, intervalSec: 90 })
  assert.deepEqual(config.servers[0].alerts, { keywords: [], damage: true, death: true })
  assert.equal(config.servers[0].resourcePack, 'accept')
  assert.equal(config.servers[0].autoLogin, null)
  assert.equal(config.deadmanMs, 600)
  assert.equal(config.minimap.radiusChunks, 6)
})

test('validateConfig keeps unknown keys and rejects bad ones', () => {
  const { config, errors } = validateConfig({
    customTop: { a: 1 },
    http: { port: 'nope', extra: true },
    servers: [{ id: 'lobby', host: 'h', customServer: 5, autoLogin: { password: 'p', trigger: '/x/' } }]
  })
  assert.ok(errors.some(e => e.includes('http.port')))
  assert.equal(config.customTop.a, 1)
  assert.equal(config.http.extra, true)
  assert.equal(config.servers[0].customServer, 5)
  assert.deepEqual(config.servers[0].autoLogin, { password: 'p', trigger: '/x/' })
})

test('validateConfig rejects duplicate ids, bad autostart, newer versions', () => {
  const { errors } = validateConfig({
    version: 99,
    accounts: [{ id: 'a', auth: 'offline', username: 'x' }, { id: 'a', auth: 'offline', username: 'y' }],
    servers: [{ id: 's', host: 'h' }, { id: 's', host: 'h2' }],
    autostart: ['nope', 'a@s']
  })
  assert.ok(errors.some(e => e.includes('newer than')))
  assert.ok(errors.some(e => e.includes('duplicate account')))
  assert.ok(errors.some(e => e.includes('duplicate server')))
  assert.ok(errors.some(e => e.includes('autostart')))
})

test('autoLogin password merge semantics', () => {
  const existing = { id: 's', host: 'h', autoLogin: { password: 'old', trigger: '/x/' } }
  // no password in the update: keep the old one
  let merged = applyServerUpdate(existing, { id: 's', host: 'h', autoLogin: { trigger: '/y/' } })
  assert.equal(merged.autoLogin.password, 'old')
  assert.equal(merged.autoLogin.trigger, '/y/')
  // empty string removes auto-login
  merged = applyServerUpdate(existing, { id: 's', host: 'h', autoLogin: { password: '', trigger: '/y/' } })
  assert.equal(merged.autoLogin, null)
  // absent autoLogin keeps the old one
  merged = applyServerUpdate(existing, { id: 's', host: 'h' })
  assert.equal(merged.autoLogin.password, 'old')
  // trigger-only update with nothing stored produces no auto-login
  merged = applyServerUpdate(null, { id: 's', host: 'h', autoLogin: { trigger: '/x/' } })
  assert.equal(merged.autoLogin, null)
  // sanitize hides the password
  const safe = sanitizeServer(existing)
  assert.equal(safe.autoLogin, undefined)
  assert.equal(safe.hasAutoLogin, true)
})

test('atomic write, file modes, token', () => {
  const dir = tempDir()
  ensureDataDir(dir)
  const config = validateConfig({ accounts: [{ id: 'a', auth: 'offline', username: 'x' }] }).config
  saveConfig(dir, config)
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.ok(fs.readdirSync(dir).every(name => !name.endsWith('.tmp')))
  const loaded = loadConfig(dir)
  assert.equal(loaded.errors.length, 0)
  assert.equal(loaded.config.accounts[0].id, 'a')

  const token1 = loadOrCreateToken(dir)
  const token2 = loadOrCreateToken(dir)
  assert.equal(token1, token2)
  assert.equal(token1.length, 43) // 32 bytes base64url
  assert.equal(fs.statSync(tokenPath(dir)).mode & 0o777, 0o600)
})

test('invalid config load reports clear errors', () => {
  const dir = tempDir()
  ensureDataDir(dir)
  fs.writeFileSync(path.join(dir, 'config.json'), '{"servers":[{"id":"Bad","host":""}]}')
  const { errors } = loadConfig(dir)
  assert.ok(errors.length >= 2)
})

test('shared storage is refused through a symlink', () => {
  const base = tempDir()
  const real = path.join(base, 'real-storage')
  fs.mkdirSync(real)
  fs.mkdirSync(path.join(real, 'nested'))
  const link = path.join(base, 'shared')
  fs.symlinkSync(real, link)
  assert.throws(
    () => assertNotSharedStorage(path.join(link, 'nested', 'golemlink'), [real]),
    /shared storage/
  )
  // and for a path that does not exist yet, resolving the nearest ancestor
  assert.throws(
    () => assertNotSharedStorage(path.join(link, 'not-yet', 'golemlink'), [real]),
    /shared storage/
  )
  const safe = path.join(base, 'safe', 'golemlink')
  assert.doesNotThrow(() => assertNotSharedStorage(safe, [real]))
})

test('resolveDataDir expands ~ and returns an absolute path', () => {
  const resolved = resolveDataDir('~/.golemlink-test-x')
  assert.ok(path.isAbsolute(resolved))
  assert.ok(!resolved.startsWith('~'))
})

test('validateServer normalizes antiAfk and alerts bounds', () => {
  const errors = []
  validateServer({ id: 's', host: 'h', antiAfk: { intervalSec: 1 }, alerts: { keywords: ['', 'x'] } }, { errors })
  assert.ok(errors.some(e => e.includes('antiAfk.intervalSec')))
  assert.ok(errors.some(e => e.includes('keywords')))
})

test('account username is required', () => {
  const errors = []
  validateAccount({ id: 'a', auth: 'microsoft', username: '' }, { errors })
  assert.ok(errors.some(e => e.includes('username')))
})
