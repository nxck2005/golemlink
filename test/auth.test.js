import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Auth, AuthError, authPath, parseCookies, loginCookie, deviceLabel, REMEMBER_MS, SETUP_CODE_MS } from '../src/auth.js'

function makeAuth (options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-auth-'))
  const codes = []
  const revoked = []
  let clock = 1_000_000
  const auth = new Auth({ dataDir, now: () => clock, onSetupCode: code => codes.push(code), onRevoke: id => revoked.push(id), ...options })
  return { auth, dataDir, codes, revoked, tick: ms => { clock += ms } }
}

const owner = { username: 'nick', password: 'correct horse', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', ip: '100.64.0.2' }

test('the setup code works once and creates the login', async () => {
  const { auth, dataDir, codes } = makeAuth()
  assert.equal(auth.isSetUp(), false)
  const { code } = auth.setupCode()
  assert.match(code, /^\d{6}$/)
  assert.deepEqual(codes, [code])
  const token = await auth.createOwner({ ...owner, code: `${code.slice(0, 3)} ${code.slice(3)}`, remember: true })
  assert.ok(auth.isSetUp())
  assert.equal(auth.verify(token).label, 'Chrome on Windows')
  await assert.rejects(auth.createOwner({ ...owner, code }), err => err.code === 'already_set_up')
  const saved = JSON.parse(fs.readFileSync(authPath(dataDir), 'utf8'))
  assert.equal(fs.statSync(authPath(dataDir)).mode & 0o777, 0o600)
  assert.equal(saved.owner.username, 'nick')
  assert.ok(!JSON.stringify(saved).includes('correct horse'), 'password stored in plain text')
  assert.ok(!JSON.stringify(saved).includes(token), 'login token stored in plain text')
})

test('setup codes expire and wrong guesses burn the code', async () => {
  const { auth, codes, tick } = makeAuth()
  const first = auth.setupCode().code
  tick(SETUP_CODE_MS + 1)
  await assert.rejects(auth.createOwner({ ...owner, code: first }), err => err.code === 'bad_code')
  assert.notEqual(auth.setupCode().code, first)
  const current = auth.setupCode().code
  // One wrong guess was used on the expired code's replacement already.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(auth.createOwner({ ...owner, ip: `10.0.0.${i}`, code: '000000' === current ? '111111' : '000000' }), err => err.code === 'bad_code')
  }
  assert.equal(auth.setupCode().code, current)
  await assert.rejects(auth.createOwner({ ...owner, ip: '10.0.1.1', code: 'nope' }), err => /new setup code/.test(err.message))
  assert.notEqual(auth.setupCode().code, current)
  assert.equal(codes.length, 3)
})

test('weak passwords and odd usernames are refused', async () => {
  const { auth } = makeAuth()
  const { code } = auth.setupCode()
  await assert.rejects(auth.createOwner({ ...owner, code, password: 'short' }), err => err.code === 'weak_password')
  await assert.rejects(auth.createOwner({ ...owner, code, username: 'has space' }), err => err.code === 'bad_username')
})

test('sign-in checks the password and limits attempts per IP', async () => {
  const { auth, tick } = makeAuth()
  await auth.createOwner({ ...owner, code: auth.setupCode().code })
  const token = await auth.signIn({ ...owner, username: 'NICK' })
  assert.ok(auth.verify(token))
  for (let i = 0; i < 5; i++) {
    await assert.rejects(auth.signIn({ ...owner, ip: '10.9.9.9', password: 'wrong password' }), err => err.code === 'bad_login')
  }
  await assert.rejects(auth.signIn({ ...owner, ip: '10.9.9.9' }), err => err instanceof AuthError && err.status === 429 && err.retryAfter > 0)
  assert.ok(await auth.signIn({ ...owner, ip: '10.9.9.8' }), 'another IP is not locked out')
  tick(61_000)
  assert.ok(await auth.signIn({ ...owner, ip: '10.9.9.9' }))
})

test('logins expire, can be revoked, and survive a restart', async () => {
  const { auth, dataDir, revoked, tick } = makeAuth()
  const remembered = await auth.createOwner({ ...owner, code: auth.setupCode().code, remember: true })
  const shortLived = await auth.signIn({ ...owner, remember: false })
  tick(8 * 24 * 3600 * 1000)
  assert.equal(auth.verify(shortLived), null)
  assert.ok(auth.verify(remembered))
  auth.flush()
  const reloaded = new Auth({ dataDir, now: () => 1_000_000 + 8 * 24 * 3600 * 1000 })
  assert.ok(reloaded.verify(remembered))
  const [entry] = auth.list()
  assert.equal(entry.id.length, 16)
  assert.equal(auth.revoke(entry.id), true)
  assert.equal(auth.verify(remembered), null)
  assert.equal(revoked.length, 2)
  tick(REMEMBER_MS)
  assert.equal(auth.revoke('short'), false)
})

test('changing the password signs out the other devices', async () => {
  const { auth, revoked } = makeAuth()
  const mine = await auth.createOwner({ ...owner, code: auth.setupCode().code })
  const other = await auth.signIn(owner)
  const keepId = auth.verify(mine).id
  await assert.rejects(auth.changePassword({ current: 'nope', next: 'new password 1', keepId, ip: owner.ip }), err => err.code === 'bad_login')
  await auth.changePassword({ current: owner.password, next: 'new password 1', keepId, ip: owner.ip })
  assert.ok(auth.verify(mine))
  assert.equal(auth.verify(other), null)
  assert.equal(revoked.length, 1)
  assert.ok(await auth.signIn({ ...owner, password: 'new password 1' }))
})

test('reset forgets the login so a new setup code is issued', async () => {
  const { auth, dataDir } = makeAuth()
  const token = await auth.createOwner({ ...owner, code: auth.setupCode().code })
  new Auth({ dataDir }).reset()
  const fresh = new Auth({ dataDir })
  assert.equal(fresh.isSetUp(), false)
  assert.equal(fresh.verify(token), null)
})

test('cookie helpers', () => {
  assert.deepEqual(parseCookies('a=1; golemlink_login=abc; b = 2'), { a: '1', golemlink_login: 'abc', b: '2' })
  assert.deepEqual(parseCookies(undefined), {})
  const cookie = loginCookie('tok', { remember: true, secure: false })
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Max-Age=7776000/)
  assert.doesNotMatch(cookie, /Secure/)
  assert.match(loginCookie('tok', { remember: false, secure: true }), /; Secure$/)
  assert.doesNotMatch(loginCookie('tok', { remember: false, secure: true }), /Max-Age/)
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit Safari/604.1'), 'Safari on iPhone')
  assert.equal(deviceLabel(''), 'Browser')
})
