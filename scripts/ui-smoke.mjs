#!/usr/bin/env node
// Optional real-browser regression checks. Install Playwright separately or
// set UI_PLAYWRIGHT_MODULE to its absolute index.mjs path. No runtime dependency.
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHttpServer } from '../src/http.js'

const { chromium } = await import(process.env.UI_PLAYWRIGHT_MODULE || 'playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = http.createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
server.on('request', createHttpServer({ webDir: path.join(root, 'web'), port, logger: console }))
const browser = await chromium.launch({ headless: true })
const errors = []

try {
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }]) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
    const accounts = []
    const servers = []
    let sessions = []
    let socket
    const sent = []
    const emit = msg => socket.send(JSON.stringify(msg))
    await page.routeWebSocket(`ws://127.0.0.1:${port}/`, ws => {
      socket = ws
      ws.onMessage(text => {
        const msg = JSON.parse(text)
        sent.push(msg)
        if (msg.t === 'auth') emit({ t: 'hello', accounts, servers, sessions, features: { goto: true } })
        if (msg.t === 'config.account.put') {
          accounts.push(msg.account)
          emit({ t: 'accounts', accounts })
        }
        if (msg.t === 'config.server.put') {
          servers.splice(0, servers.length, { ...msg.server, hasAutoLogin: true })
          emit({ t: 'servers', servers })
        }
        if (msg.t === 'session.start') {
          sessions = [{ id: `${msg.account}@${msg.server}`, state: 'connecting' }, { id: 'alt@other', state: 'online' }]
          emit({ t: 'sessions', sessions })
        }
        if (msg.t === 'sub') {
          const session = sessions.find(session => session.id === msg.s)
          if (session?.state === 'connecting') {
            emit({ t: 'snapshot', s: msg.s, state: 'connecting', inventory: null, window: null, cursor: null, chat: [], players: [] })
            session.state = 'online'
            emit({ t: 'state', s: msg.s, state: 'online' })
          }
          const slots = Array(46).fill(null)
          slots[9] = { n: 'diamond', d: 'Diamond', c: 4 }
          emit({ t: 'snapshot', s: msg.s, status: { x: 12, y: 64, z: -8, hp: 16, food: 18, xpLvl: 7, xpProgress: 0.5, yaw: 0, ctl: {} },
            inventory: { id: 0, slots }, cursor: { n: 'stone', c: 2 }, players: [],
            chat: [{ plain: 'Welcome to the server', ts: Date.now() }, { plain: 'Alex: hello there', ts: Date.now() }] })
        }
      })
    })
    await page.goto(`http://127.0.0.1:${port}/#t=smoke-token`)
    await page.locator('#setup-open').click()
    await page.getByRole('button', { name: '+ Add account', exact: true }).click()
    let form = page.locator('#accounts-list form')
    await form.getByLabel('id', { exact: true }).fill('Invalid ID!')
    assert.equal(await form.getByLabel('id', { exact: true }).evaluate(el => el.checkValidity()), false)
    await form.getByLabel('id', { exact: true }).fill('main')
    await form.getByLabel('username', { exact: true }).fill('Explorer')
    await form.getByRole('button', { name: 'Add account', exact: true }).click()
    await page.getByRole('button', { name: '+ Add server', exact: true }).click()
    form = page.locator('#servers-list form')
    await form.getByLabel('id', { exact: true }).fill('lobby')
    await form.getByLabel('name', { exact: true }).fill('My survival world')
    await form.getByLabel('host', { exact: true }).fill('localhost')
    await form.getByRole('button', { name: 'Add server', exact: true }).click()
    await page.getByRole('button', { name: 'Start session →' }).click()
    await page.waitForFunction(() => document.getElementById('session-label').textContent === 'main@lobby')
    await page.locator('[data-tab="chat"]').click()
    assert.equal(await page.locator('#hp-fill').evaluate(el => el.style.width), '80%')
    assert.equal(await page.locator('#food-fill').evaluate(el => el.style.width), '90%')
    assert.equal(await page.locator('#xp-fill').evaluate(el => el.style.width), '50%')
    await page.locator('#chat-search').fill('Alex')
    assert.equal(await page.locator('.chat-line').count(), 1)
    await page.locator('#chat-search').fill('not a message')
    assert.match(await page.locator('#chat-log').textContent(), /No messages match/)
    await page.locator('#chat-search').fill('')
    await page.locator('#chat-input').fill('Hello world')
    await page.locator('#chat-send').click()
    assert.ok(sent.some(msg => msg.t === 'chat' && msg.text === 'Hello world'))

    // Foreign inventory/map packets are ignored; an empty slot accepts the cursor.
    emit({ t: 'inv', s: 'alt@other', window: 0, slots: { 10: { n: 'gold_ingot', c: 1 } }, cursor: null })
    await page.locator('[data-tab="bag"]').click()
    assert.equal(await page.locator('#bag-empty').isVisible(), false, 'inventory must initialize after connecting')
    assert.equal(await page.locator('#details-toggle').isEnabled(), true)
    await page.locator('#inv-grid .cell').nth(1).click()
    assert.ok(sent.some(msg => msg.t === 'click' && msg.s === 'main@lobby' && msg.slot === 10))
    assert.match(await page.locator('#cursor-item').textContent(), /stone/i)
    await page.locator('#inv-grid .cell').nth(2).focus()
    await page.keyboard.press('Enter')
    assert.ok(sent.some(msg => msg.t === 'click' && msg.slot === 11))

    // A lobby's selector item is a container button, not a held item to use.
    const menuSlots = Array(72).fill(null)
    menuSlots[12] = { n: 'netherite_pickaxe', d: 'Join survival', c: 1 }
    emit({ t: 'window', s: 'main@lobby', window: { id: 7, type: 'minecraft:generic_9x4', invStart: 36, slots: menuSlots } })
    const menuItem = page.locator('#window-grid .cell').nth(12)
    const menuClicks = () => sent.filter(msg => msg.t === 'click' && msg.window === 7)
    let clickCount = menuClicks().length
    await menuItem.click({ button: 'right', delay: 650 })
    assert.equal(menuClicks().length, ++clickCount, 'mouse right-click sends exactly one packet')
    assert.deepEqual(menuClicks().at(-1), { t: 'click', s: 'main@lobby', window: 7, slot: 12, button: 1, mode: 0 })
    await page.locator('#details-toggle').click()
    await menuItem.click()
    const sheet = page.locator('#sheet')
    assert.equal(await sheet.getByRole('button', { name: 'Use held item', exact: true }).count(), 0)
    await sheet.getByRole('button', { name: 'Right click', exact: true }).click()
    assert.equal(menuClicks().length, ++clickCount)
    assert.equal(menuClicks().at(-1).button, 1)
    await menuItem.click()
    await sheet.getByRole('button', { name: 'Left click', exact: true }).click()
    assert.equal(menuClicks().length, ++clickCount)
    assert.equal(menuClicks().at(-1).button, 0)
    await menuItem.click({ button: 'right' })
    assert.equal(menuClicks().length, ++clickCount, 'native right-click also works in details mode')
    assert.equal(menuClicks().at(-1).button, 1)
    await page.locator('#details-toggle').click()
    await menuItem.click({ delay: 650 })
    assert.equal(menuClicks().length, ++clickCount, 'long press must not also send a left-click')
    assert.equal(menuClicks().at(-1).button, 1)
    await menuItem.click()
    assert.equal(menuClicks().length, ++clickCount)
    assert.equal(menuClicks().at(-1).button, 0)
    emit({ t: 'window', s: 'main@lobby', window: null })

    for (const tab of ['chat', 'move', 'bag', 'more']) {
      await page.locator(`[data-tab="${tab}"]`).click()
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.tab.active, .tab.active *')].filter(el => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1)
      }).map(el => el.id || el.className))
      assert.deepEqual(overflow, [], `${viewport.width}px ${tab} has horizontal overflow`)
      if (tab === 'move') {
        const controlsVisible = await page.locator('#move-bottom').evaluate(el => {
          const rect = el.getBoundingClientRect()
          return rect.top >= 0 && rect.bottom <= innerHeight
        })
        assert.ok(controlsVisible, 'movement controls should remain on screen')
        await page.locator('#btn-jump').hover()
        await page.mouse.down()
        await page.locator('[data-tab="chat"]').evaluate(el => el.click())
        await page.mouse.up()
        assert.ok(sent.some(msg => msg.t === 'ctl' && msg.k === 'jump' && msg.on))
        assert.ok(sent.some(msg => msg.t === 'ctl' && msg.k === 'jump' && !msg.on))
        await page.locator('[data-tab="move"]').click()
      }
      if (process.env.UI_SCREENSHOTS) {
        await fs.mkdir(process.env.UI_SCREENSHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.UI_SCREENSHOTS, `${viewport.width}-${tab}.png`) })
      }
    }

    // Editing can be cancelled and an existing login can explicitly be removed.
    await page.locator('#servers-list').getByRole('button', { name: 'Edit', exact: true }).click()
    await page.locator('#servers-list form').getByRole('button', { name: 'Cancel' }).click()
    await page.locator('#servers-list').getByRole('button', { name: 'Edit', exact: true }).click()
    form = page.locator('#servers-list form')
    await form.locator('summary').click()
    await form.getByLabel('Remove saved auto-login').check()
    await form.getByRole('button', { name: 'Save server' }).click()
    assert.equal(sent.filter(msg => msg.t === 'config.server.put').at(-1).server.autoLogin, null)

    // Session changes clear old chat/suggestions; live traffic remains isolated.
    await page.locator('#session-picker').click()
    await page.getByRole('option', { name: 'alt@other' }).click()
    await page.waitForFunction(() => document.getElementById('session-label').textContent === 'alt@other')
    assert.ok(sent.some(msg => msg.t === 'sub' && msg.s === 'alt@other'))
    console.log(`ok UI smoke: ${viewport.width} × ${viewport.height}`)
    await context.close()
  }
  assert.deepEqual(errors, [], 'browser errors or CSP violations')
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
