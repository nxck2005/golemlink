#!/usr/bin/env node
// Real browser -> WebSocket -> daemon movement -> Mineflayer -> Minecraft
// protocol integration. Uses only a disposable offline test server/account.
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig, ensureDataDir } from '../src/config.js'
import { createHttpServer } from '../src/http.js'
import { Sessions } from '../src/sessions.js'
import { WsHub } from '../src/ws.js'
import { startFakeServer } from './fake-server.mjs'

const { chromium } = await import(process.env.UI_PLAYWRIGHT_MODULE || 'playwright')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (predicate, message) {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await sleep(25)
  }
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await fs.mkdir('/tmp/opencode', { recursive: true })
const dataDir = await fs.mkdtemp('/tmp/opencode/golemlink-movement-')
const { token } = ensureDataDir(dataDir)
const fake = await startFakeServer()
const config = defaultConfig()
config.accounts = [{ id: 'ui', username: 'JoystickTest', auth: 'offline' }]
config.servers = [{ id: 'test', host: '127.0.0.1', port: fake.port, version: fake.version, autoReconnect: false, chatLog: false }]
const logger = { info () {}, warn () {}, error (...args) { console.error(...args) } }
const termux = { available: {}, notify () {} }
const server = http.createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
server.on('request', createHttpServer({ webDir: path.join(root, 'web'), port, logger }))
const sessions = new Sessions({ getConfig: () => config, dataDir, logger, termux })
const hub = new WsHub({ server, port, token, sessions, logger, termux, control: {
  accountsForUi: () => config.accounts, serversForUi: () => config.servers,
  daemonInfo: () => null, startSession: (account, host) => sessions.start(account, host)
} })
sessions.hub = hub
hub.attach()
const browser = await chromium.launch({ headless: true })
const errors = []

try {
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, hasTouch: true })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${port}/#t=${token}`)
    await page.locator('[data-tab="more"]').click()
    await page.getByRole('button', { name: 'Start session →' }).click()
    await until(() => sessions.get('ui@test')?.state === 'online', 'bot never came online')
    await page.locator('[data-tab="move"]').click()
    await page.waitForFunction(() => !document.getElementById('btn-jump').disabled)
    const session = sessions.get('ui@test')
    const ctl = key => session.movement.ctlState()[key]
    const released = () => ['forward', 'back', 'left', 'right', 'jump'].every(key => !ctl(key))
    const box = await page.locator('#joystick').boundingBox()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const radius = box.width / 2 - 32
    const point = (id, px, py) => ({ id, x: px, y: py })

    const startDrag = async () => {
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y - radius)
      await until(() => ctl('forward'), 'drag did not press forward')
    }
    const assertStopped = async () => {
      await until(released, 'movement keys stuck after release')
      // A released jump still has normal Minecraft airborne momentum. Check
      // sustained drift only after landing, not in the middle of that jump.
      await until(() => session.bot.entity.onGround, 'bot did not land after releasing controls')
      await sleep(350) // Minecraft applies friction after releasing a key.
      const start = { ...fake.position() }
      await sleep(500)
      const end = fake.position()
      assert.ok(Math.hypot(end.x - start.x, end.z - start.z) < 0.1, 'bot keeps moving after release')
      assert.equal(session.movement.gotoState, null, 'joystick must not start a map goto')
    }

    const before = { ...fake.position() }
    const yaw = session.bot.entity.yaw
    await startDrag()
    await sleep(1200) // No pointermove: heartbeats must keep a stationary drag alive.
    const after = fake.position()
    const distance = Math.hypot(after.x - before.x, after.z - before.z)
    assert.ok(distance > 2 && distance < 8, `unexpected walk distance: ${distance}`)
    const forwardDistance = (after.x - before.x) * -Math.sin(yaw) + (after.z - before.z) * -Math.cos(yaw)
    assert.ok(forwardDistance > 2, 'up on the joystick must move in the direction the bot faces')
    assert.ok(ctl('forward'), 'stationary drag expired despite heartbeats')
    await page.mouse.move(x + radius, y)
    await until(() => ctl('right') && !ctl('forward') && !ctl('left') && !ctl('back'), 'changing direction left old keys pressed')
    await page.mouse.move(x, y)
    await assertStopped() // Dead zone must stop movement while still holding.
    await page.mouse.move(x, y - radius)
    await until(() => ctl('forward'), 'drag could not resume from the dead zone')
    await page.mouse.move(x, 1) // Release well outside the joystick.
    await page.mouse.up()
    await assertStopped()

    await startDrag()
    await page.locator('#joystick').evaluate(el => el.releasePointerCapture(1))
    await assertStopped()
    await page.mouse.up()

    await startDrag()
    hub.sendToSubscribers(session.id, session.snapshot())
    await assertStopped() // Resync must release daemon keys, not just local state.
    await page.mouse.up()

    await startDrag()
    await page.locator('[data-tab="chat"]').evaluate(el => el.click())
    await assertStopped()
    await page.mouse.up()
    await page.locator('[data-tab="move"]').click()

    await startDrag()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await assertStopped()
    await page.mouse.up()

    // Real touch pointers: the joystick's first finger must not block a
    // second finger on Jump. Releasing/cancelling must clear both controls.
    const cdp = await context.newCDPSession(page)
    const finger = point(1, x, y - radius)
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
    await touch('touchStart', [finger])
    await until(() => ctl('forward'), 'touch joystick did not move')
    const jumpBox = await page.locator('#btn-jump').boundingBox()
    const thumb = point(2, jumpBox.x + jumpBox.width / 2, jumpBox.y + jumpBox.height / 2)
    await touch('touchStart', [finger, thumb])
    await until(() => ctl('forward') && ctl('jump'), 'second finger could not jump while moving')
    await touch('touchEnd', [])
    await assertStopped()
    await touch('touchStart', [finger])
    await until(() => ctl('forward'), 'second touch drag failed')
    await touch('touchCancel', [])
    await assertStopped()

    console.log(`ok real joystick: ${viewport.width}px, ${distance.toFixed(2)} blocks walked; direction/dead zone/release/capture/resync/blur/tab/touch/jump checked`)
    await context.close()
    session.stop()
    await sleep(300)
  }
  assert.deepEqual(errors, [], 'browser errors')
} finally {
  await browser.close()
  hub.destroy()
  sessions.destroyAll()
  await fake.stop()
  await new Promise(resolve => server.close(resolve))
  await fs.rm(dataDir, { recursive: true, force: true })
}
