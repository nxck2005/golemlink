#!/usr/bin/env node
// Optional real-browser regression checks. Install Playwright separately or
// set UI_PLAYWRIGHT_MODULE to its absolute index.mjs path. No runtime dependency.
// The HTTP side (pages, sign-in API) is real; the WebSocket is a scripted fake.
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHttpServer } from '../src/http.js'
import { createApi } from '../src/api.js'
import { Auth } from '../src/auth.js'
import { buildAccess } from '../src/access.js'

const { chromium } = await import(process.env.UI_PLAYWRIGHT_MODULE || 'playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'golemlink-ui-'))
const logger = { info () {}, warn () {}, error (...args) { console.error(...args) } }
let setupCode = null
const auth = new Auth({ dataDir, logger, onSetupCode: code => { setupCode = code } })
const server = http.createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const access = buildAccess({ port })
server.on('request', createHttpServer({ webDir: path.join(root, 'web'), access, auth, api: createApi({ auth, access, logger }), logger }))
const browser = await chromium.launch({ headless: true })
const errors = []
const USER = { username: 'smoke', password: 'smoke-password' }
const seg = (x, c) => c ? { x, c } : { x }
const PLAYERS = [
  { name: 'golem', ping: 38, me: true, dn: [seg('[Member] ', '#aaaaaa'), seg('golem', '#ffffff')] },
  { name: 'Alex', ping: 30, dn: [seg('[VIP] ', '#55ff55'), seg('Alex', '#55ff55')] },
  { name: 'Steve_Builds', ping: 112 },
  { name: 'a_rather_long_name', ping: 64, dn: [seg('[Mod] ', '#ff5555'), seg('a_rather_long_name', '#ffffff')] },
  { name: 'Kai', ping: 9 }
]
const BOARD = {
  sidebar: {
    title: [{ x: 'SURVIVAL', c: '#ffff55', b: 1 }],
    lines: [
      { segs: [seg('11/02/26', '#aaaaaa')] },
      { segs: [] },
      { segs: [seg('Rank: ', '#ffffff'), seg('Member', '#55ffff')] },
      { segs: [seg('Balance: ', '#ffffff'), seg('$12,480', '#ffaa00')] },
      { segs: [seg('Claim blocks: ', '#ffffff'), seg('1,250', '#55ff55')] },
      { segs: [seg('Kills: ', '#ffffff'), seg('14', '#ff5555')] },
      { segs: [seg('Playtime: ', '#ffffff'), seg('41h', '#ffff55')] },
      { segs: [] },
      { segs: [seg('play.example.net', '#ffff55')] }
    ]
  },
  bars: [{ id: 'b1', segs: [{ x: 'Dragon event starts soon', c: '#ff55ff', b: 1 }], health: 0.68, color: 'purple' }],
  tab: { header: [seg('Welcome to ', '#ffffff'), seg('Example', '#ffaa00'), seg('\nplay.example.net', '#aaaaaa')], footer: [seg('Store: store.example.net', '#55ffff')] }
}

try {
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }]) {
    const desktop = viewport.width >= 1100
    const context = await browser.newContext({ viewport, hasTouch: !desktop })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
    const accounts = []
    const servers = []
    let sessions = []
    let socket
    const sent = []
    const emit = msg => socket.send(JSON.stringify(msg))
    const view = async name => {
      if (desktop && name === 'chat') return
      await page.locator(desktop ? `.rail-item[data-view="${name}"]` : `.p-tab[data-view="${name}"]`).click()
    }
    await page.routeWebSocket(`ws://127.0.0.1:${port}/`, ws => {
      socket = ws
      ws.onMessage(text => {
        const msg = JSON.parse(text)
        sent.push(msg)
        if (msg.t === 'config.account.put') {
          accounts.push(msg.account)
          emit({ t: 'accounts', accounts })
        }
        if (msg.t === 'config.server.put') {
          const { autoLogin, ...rest } = msg.server
          servers.splice(0, servers.length, { ...rest, hasAutoLogin: autoLogin !== null })
          emit({ t: 'servers', servers })
        }
        if (msg.t === 'session.start') {
          sessions = [{ id: `${msg.account}@${msg.server}`, account: msg.account, server: msg.server, state: 'connecting' }, { id: 'alt@other', account: 'alt', server: 'other', state: 'online', onlineMs: 3_600_000 }]
          emit({ t: 'sessions', sessions })
        }
        if (msg.t === 'sub') {
          const session = sessions.find(session => session.id === msg.s)
          if (session?.state === 'connecting') {
            session.state = 'online'
            session.onlineMs = 120_000
            emit({ t: 'sessions', sessions })
          }
          const slots = Array(46).fill(null)
          slots[9] = { n: 'diamond', d: 'Diamond', c: 4, lore: [] }
          slots[36] = { n: 'compass', d: 'Compass', cn: 'Server selector', c: 1, lore: ['Right click to pick a server'] }
          emit({ t: 'snapshot', s: msg.s, status: { x: 12, y: 64, z: -8, hp: 16, food: 18, xpLvl: 7, xpProgress: 0.5, yaw: 0, pitch: 0, quick: 0, ping: 42, ctl: {} },
            inventory: { id: 0, slots }, window: null, cursor: { n: 'stone', d: 'Stone', c: 2 }, players: PLAYERS, board: BOARD,
            chat: [{ plain: 'Welcome to the server', ts: Date.now() }, { plain: 'Alex: hello there', ts: Date.now() }] })
        }
      })
      emit({ t: 'hello', user: USER.username, accounts, servers, sessions, textures: [], features: { goto: true, clickModes: ['normal', 'shift'] } })
    })

    // First run creates the login with the setup code; later runs sign in.
    await page.goto(`http://127.0.0.1:${port}/`)
    if (!auth.isSetUp()) {
      await page.locator('#auth-setup').waitFor()
      assert.ok(setupCode, 'the daemon made a setup code')
      await page.locator('#setup-code').fill('000000')
      await page.locator('#setup-username').fill(USER.username)
      await page.locator('#setup-password').fill(USER.password)
      await page.locator('#auth-setup button[type="submit"]').click()
      await page.waitForFunction(() => document.getElementById('setup-error').textContent.length > 0)
      await page.locator('#setup-code').fill(setupCode)
      await page.locator('#auth-setup button[type="submit"]').click()
    } else {
      await page.locator('#auth-signin').waitFor()
      await page.locator('#signin-username').fill(USER.username)
      if (viewport.width === 390) {
        await page.locator('#signin-password').fill('wrong password')
        await page.locator('#auth-signin button[type="submit"]').click()
        await page.waitForFunction(() => document.getElementById('signin-error').textContent.length > 0)
      }
      await page.locator('#signin-password').fill(USER.password)
      await page.locator('#auth-signin button[type="submit"]').click()
    }
    await page.locator('#app').waitFor()
    assert.match(await page.locator('#empty-title').textContent(), /Start a session/)

    // Setup: an account, a server, then a session.
    await page.locator('#empty-setup').click()
    await page.locator('#add-account').click()
    let form = page.locator('#accounts-list form')
    await form.getByLabel('ID', { exact: true }).fill('Invalid ID!')
    assert.equal(await form.getByLabel('ID', { exact: true }).evaluate(el => el.checkValidity()), false)
    await form.getByLabel('ID', { exact: true }).fill('main')
    await form.getByLabel('Sign-in').selectOption('offline')
    await form.getByLabel('Username', { exact: true }).fill('Explorer')
    await form.getByRole('button', { name: 'Add account', exact: true }).click()
    await page.locator('#add-server').click()
    form = page.locator('#servers-list form')
    await form.getByLabel('ID', { exact: true }).fill('lobby')
    await form.getByLabel('Name', { exact: true }).fill('My survival world')
    await form.getByLabel('Host', { exact: true }).fill('localhost')
    await form.getByRole('button', { name: 'Add server', exact: true }).click()
    await page.locator('#new-session').click()
    await page.locator('#start-form').getByRole('button', { name: 'Start session' }).click()
    await page.waitForFunction(() => document.getElementById('picker-label').textContent === 'main @ lobby')
    await page.waitForFunction(() => document.getElementById('logins-list').childElementCount > 0)
    assert.match(await page.locator('#logins-list').textContent(), /This device/)

    // Play shows the session without any extra mode.
    await view('play')
    if (desktop) {
      assert.equal(await page.locator('#bar-hp-fill').evaluate(el => el.style.width), '80%')
      assert.equal(await page.locator('#bar-food-fill').evaluate(el => el.style.width), '90%')
      assert.equal(await page.locator('#bar-lv-fill').evaluate(el => el.style.width), '50%')
    } else {
      assert.equal(await page.locator('#p-hp').textContent(), '16')
      assert.equal(await page.locator('#hb-time').isVisible(), true)
      assert.match(await page.locator('#recent-chat').textContent(), /hello there/)
    }
    assert.match(await page.locator('#held-name').textContent(), /Server selector/)
    assert.match(await page.locator('#cursor-text').textContent(), /Stone/)

    // The held compass: Use sends use; tapping the selected hotbar slot uses it too.
    emit({ t: 'inv', s: 'main@lobby', window: 0, slots: {}, cursor: null })
    await page.locator('#cursor-banner').waitFor({ state: 'hidden' })
    const uses = () => sent.filter(msg => msg.t === 'use').length
    let useCount = uses()
    await page.locator('#btn-use').click()
    assert.equal(uses(), ++useCount)
    const hotbar0 = page.locator('#hotbar-grid .slot').nth(0)
    if (desktop) await hotbar0.click()
    else await hotbar0.tap()
    assert.equal(uses(), ++useCount, 'tapping the selected slot uses the item')
    const hotbar3 = page.locator('#hotbar-grid .slot').nth(3)
    if (desktop) await hotbar3.click()
    else await hotbar3.tap()
    assert.deepEqual(sent.filter(msg => msg.t === 'hotbar').at(-1), { t: 'hotbar', s: 'main@lobby', i: 3 })

    // Foreign packets are ignored; inventory clicks go to the selected bot.
    emit({ t: 'inv', s: 'alt@other', window: 0, slots: { 10: { n: 'gold_ingot', c: 1 } }, cursor: null })
    if (!desktop) await page.locator('#pack-toggle').click()
    const packSlot = page.locator('#pack-grid .slot').nth(1)
    if (desktop) await packSlot.click()
    else await packSlot.tap()
    assert.deepEqual(sent.filter(msg => msg.t === 'click').at(-1), { t: 'click', s: 'main@lobby', window: 0, slot: 10, button: 0, mode: 0 })

    // A server selector opens a chest; it appears on Play straight away.
    const menuSlots = Array(72).fill(null)
    menuSlots[12] = { n: 'grass_block', d: 'Grass Block', cn: 'Survival', c: 1, lore: ['42 playing'] }
    emit({ t: 'window', s: 'main@lobby', window: { id: 7, type: 'minecraft:generic_9x4', title: { plain: 'Pick a server' }, invStart: 36, size: 72, slots: menuSlots } })
    await page.locator('#window-panel').waitFor()
    assert.equal(await page.locator('#window-title').textContent(), 'Pick a server')
    assert.equal(await page.locator('#window-grid .slot').count(), 36)
    const menuItem = page.locator('#window-grid .slot').nth(12)
    const menuClicks = () => sent.filter(msg => msg.t === 'click' && msg.window === 7)
    let clickCount = menuClicks().length
    if (desktop) {
      await menuItem.click()
      assert.equal(menuClicks().length, ++clickCount)
      assert.deepEqual(menuClicks().at(-1), { t: 'click', s: 'main@lobby', window: 7, slot: 12, button: 0, mode: 0 })
      await menuItem.click({ button: 'right' })
      assert.equal(menuClicks().length, ++clickCount, 'mouse right-click sends exactly one packet')
      assert.equal(menuClicks().at(-1).button, 1)
      await menuItem.click({ modifiers: ['Shift'] })
      assert.equal(menuClicks().at(-1).mode, 1)
      clickCount++
      await menuItem.hover()
      await page.locator('#tooltip').waitFor()
      assert.match(await page.locator('#tooltip').textContent(), /Survival.*42 playing/)
      // Inventory slots map into the open window.
      await page.locator('#pack-grid .slot').nth(0).click()
      assert.equal(menuClicks().at(-1).slot, 36)
      clickCount++
    } else {
      await menuItem.tap()
      assert.equal(menuClicks().length, ++clickCount, 'a tap is a left click')
      assert.equal(menuClicks().at(-1).button, 0)
      // A long press opens the slot menu and sends nothing by itself.
      await menuItem.evaluate(async node => {
        const rect = node.getBoundingClientRect()
        const init = { bubbles: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: rect.x + 10, clientY: rect.y + 10 }
        node.dispatchEvent(new PointerEvent('pointerdown', init))
        await new Promise(resolve => setTimeout(resolve, 600))
        node.dispatchEvent(new PointerEvent('pointerup', init))
      })
      assert.equal(menuClicks().length, clickCount, 'long press must not also send a click')
      const slotMenu = page.locator('#slot-menu')
      await slotMenu.waitFor()
      await slotMenu.getByRole('menuitem', { name: 'Right click' }).click()
      assert.equal(menuClicks().length, ++clickCount)
      assert.equal(menuClicks().at(-1).button, 1)
      assert.equal(await slotMenu.isVisible(), false)
    }
    if (desktop) await page.keyboard.press('Escape')
    else await page.locator('#close-window').click()
    assert.ok(sent.some(msg => msg.t === 'closeWindow'))
    emit({ t: 'window', s: 'main@lobby', window: null })
    await page.locator('#window-panel').waitFor({ state: 'hidden' })

    // Chat: search, send, and suggestions.
    await view('chat')
    await page.locator('#chat-search-toggle').click()
    await page.locator('#chat-search').fill('Alex')
    assert.equal(await page.locator('#chat-log .chat-line').count(), 1)
    await page.locator('#chat-search').fill('not a message')
    assert.match(await page.locator('#chat-log').textContent(), /No messages match/)
    await page.locator('#chat-search-toggle').click()
    assert.equal(await page.locator('#chat-log .chat-line').count(), 2)
    await page.locator('#chat-input').fill('Hello world')
    await page.locator('#chat-send').click()
    assert.ok(sent.some(msg => msg.t === 'chat' && msg.text === 'Hello world'))

    // The scoreboard sits on Play; the Server view has it with the tab list.
    await view('play')
    await page.locator('#board-card .sb-line').first().waitFor()
    assert.equal(await page.locator('#play-bars .boss').count(), 1)
    if (!desktop) {
      assert.equal(await page.locator('#board-card .sb > :visible').count(), 5)
      await page.locator('#board-card .sb-more').click()
      assert.equal(await page.locator('#board-card .sb > :visible').count(), BOARD.sidebar.lines.length)
    }
    await view('server')
    assert.equal(await page.locator('#tab-players .tab-player').count(), PLAYERS.length)
    assert.match(await page.locator('#tab-header').innerText(), /play\.example\.net/)

    for (const name of ['play', 'chat', 'server', 'move', 'setup']) {
      if (desktop && name === 'chat') continue
      await view(name)
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && el.offsetParent !== null && getComputedStyle(el.parentElement).overflow !== 'hidden' && (rect.right > innerWidth + 1 || rect.left < -1)
      }).map(el => el.id || el.className || `${el.tagName}<${el.parentElement?.className}`).slice(0, 5))
      assert.deepEqual(overflow, [], `${viewport.width}px ${name} has horizontal overflow`)
      if (name === 'move') {
        await page.waitForFunction(() => !document.getElementById('btn-jump').disabled)
        const jump = await page.locator('#btn-jump').boundingBox()
        assert.ok(jump.y + jump.height <= viewport.height || viewport.height < 500, 'jump stays on screen')
        await page.locator('#btn-jump').hover()
        await page.mouse.down()
        await page.mouse.up()
        assert.ok(sent.some(msg => msg.t === 'ctl' && msg.k === 'jump' && msg.on))
        assert.ok(sent.some(msg => msg.t === 'ctl' && msg.k === 'jump' && !msg.on))
        // Dragging on the map looks around; a tap offers to walk there.
        const map = await page.locator('#map').boundingBox()
        const cx = map.x + map.width / 2
        const cy = map.y + map.height / 2
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        await page.mouse.move(cx + 40, cy, { steps: 4 })
        await page.mouse.up()
        await page.waitForFunction(() => true)
        assert.ok(sent.some(msg => msg.t === 'look'), 'dragging the map sends look')
        assert.equal(await page.locator('#goto-chip').isVisible(), false)
        await page.mouse.click(cx + 30, cy + 20)
        await page.locator('#goto-chip').waitFor()
        await page.locator('#goto-go').click()
        assert.ok(sent.some(msg => msg.t === 'goto'))
      }
      if (process.env.UI_SCREENSHOTS) {
        await fs.mkdir(process.env.UI_SCREENSHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.UI_SCREENSHOTS, `${viewport.width}-${name}.png`) })
      }
    }

    // Window screenshot for the Play view, the main use of the page.
    if (process.env.UI_SCREENSHOTS) {
      await view('play')
      emit({ t: 'window', s: 'main@lobby', window: { id: 8, type: 'minecraft:generic_9x3', title: { plain: 'Pick a server' }, invStart: 27, size: 63, slots: menuSlots.slice(0, 63) } })
      await page.locator('#window-panel').waitFor()
      await page.screenshot({ path: path.join(process.env.UI_SCREENSHOTS, `${viewport.width}-window.png`) })
      emit({ t: 'window', s: 'main@lobby', window: null })
    }

    // Editing can be cancelled and an existing login can explicitly be removed.
    await view('setup')
    await page.locator('#servers-list').getByRole('button', { name: 'Edit', exact: true }).click()
    await page.locator('#servers-list form').getByRole('button', { name: 'Cancel' }).click()
    await page.locator('#servers-list').getByRole('button', { name: 'Edit', exact: true }).click()
    form = page.locator('#servers-list form')
    await form.locator('summary').click()
    await form.getByText('Remove the saved auto-login').click()
    await form.getByRole('button', { name: 'Save server' }).click()
    assert.equal(sent.filter(msg => msg.t === 'config.server.put').at(-1).server.autoLogin, null)

    // Switching sessions subscribes to the other bot.
    if (desktop) {
      await page.locator('.rail-sess', { hasText: 'alt @ other' }).click()
    } else {
      await page.locator('#session-picker').click()
      await page.getByRole('option', { name: /alt @ other/ }).click()
    }
    await page.waitForFunction(() => document.getElementById('picker-label').textContent === 'alt @ other')
    assert.ok(sent.some(msg => msg.t === 'sub' && msg.s === 'alt@other'))

    // Signing out returns to the sign-in screen.
    if (desktop) {
      await page.locator('#sign-out').click()
      await page.locator('#auth-signin').waitFor()
    }
    console.log(`ok UI smoke: ${viewport.width} × ${viewport.height}`)
    await context.close()
  }
  assert.deepEqual(errors.filter(e => !/status of 40[13]/.test(e)) /* the deliberate wrong code and password */, [], 'browser errors or CSP violations')
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await fs.rm(dataDir, { recursive: true, force: true })
}
