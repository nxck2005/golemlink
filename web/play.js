// Play: the open window, backpack, hotbar and held item, with click
// handling that matches the game on desktop and works one-handed on touch.
import { store } from './store.js'
import { send } from './net.js'
import { itemTile, itemName, onTexturesLoaded } from './items.js'
import { el, sessionStatus, dotClass, clock } from './format.js'
import { isTypingTarget } from './keyboard.js'

const LONG_PRESS_MS = 450
const ARMOR_SLOTS = [5, 6, 7, 8]
const OFFHAND = 45
const ARMOR_NAMES = ['Helmet', 'Chestplate', 'Leggings', 'Boots']

const CONTAINER_COLUMNS = [
  [/hopper/, 5],
  [/dispenser|dropper|crafter/, 3],
  [/brewing/, 5],
  [/furnace|smoker|anvil|grindstone|smithing|cartography|stonecutter|beacon|loom|enchantment|merchant/, 3]
]

let hovered = null // { kind, slot } under the mouse, for Q to drop
let press = null
let menuFor = null
let packOpen = false

function sid () {
  return store.sessionId
}

function online () {
  return store.connected && store.session()?.state === 'online'
}

export function serverFor (session = store.session()) {
  return session ? store.servers.find(s => s.id === session.server) || null : null
}

// Turns anti-AFK on or off in the session's server config.
export function setAntiAfk (on) {
  const server = serverFor()
  if (!server) return
  const { hasAutoLogin, ...rest } = server
  send({ t: 'config.server.put', server: { ...rest, antiAfk: { ...(server.antiAfk || {}), enabled: on } } })
}

function containerColumns (type) {
  for (const [pattern, columns] of CONTAINER_COLUMNS) {
    if (pattern.test(type || '')) return columns
  }
  return 9
}

function playerItem (slot) {
  const w = store.window
  if (w && slot >= 9 && slot <= 44) return w.slots?.[w.invStart + (slot - 9)] ?? null
  return store.inventory?.slots?.[slot] ?? null
}

function itemAt ({ kind, slot }) {
  return kind === 'win' ? store.window?.slots?.[slot] ?? null : playerItem(slot)
}

// Window and slot numbers for a click, mapping the player's inventory into
// an open container window.
function clickTarget ({ kind, slot }) {
  if (kind === 'win') return { windowId: store.window.id, slot }
  const w = store.window
  if (w && slot >= 9 && slot <= 44) return { windowId: w.id, slot: w.invStart + (slot - 9) }
  return { windowId: 0, slot }
}

function click (target, button, mode = 0) {
  if (!online()) return
  const { windowId, slot } = clickTarget(target)
  send({ t: 'click', s: sid(), window: windowId, slot, button, mode })
}

function drop (target, all) {
  if (!online() || store.cursor || !itemAt(target)) return
  send({ t: 'drop', s: sid(), slot: clickTarget(target).slot, all })
}

function hotbarIndex ({ kind, slot }) {
  return kind === 'player' && slot >= 36 && slot <= 44 ? slot - 36 : null
}

export function selectHotbar (i) {
  if (online() && i >= 0 && i <= 8) send({ t: 'hotbar', s: sid(), i })
}

export function useItem () {
  if (online()) send({ t: 'use', s: sid() })
}

export function interact () {
  if (online()) send({ t: 'interact', s: sid() })
}

export function closeWindow () {
  if (store.window && online()) send({ t: 'closeWindow', s: sid() })
}

// A tap or plain left click. With no window open, the hotbar selects its
// slot, and a second tap on the selected slot uses the item.
function primary (target) {
  const i = hotbarIndex(target)
  if (i !== null && !store.window && !store.cursor) {
    if (store.status?.quick === i) useItem()
    else selectHotbar(i)
    return
  }
  click(target, 0, 0)
}

// --- rendering -------------------------------------------------------------
function makeSlot (target, { ghost, label } = {}) {
  const item = itemAt(target)
  const cell = el('button', 'slot')
  cell.type = 'button'
  cell.dataset.kind = target.kind
  cell.dataset.slot = String(target.slot)
  cell.setAttribute('aria-label', item ? `${itemName(item)}${item.c > 1 ? `, ${item.c}` : ''}` : `Empty ${label || 'slot'}`)
  if (item) cell.appendChild(itemTile(item))
  else if (ghost) cell.appendChild(el('span', 'armor-ghost'))
  return cell
}

function fillGrid (grid, targets, options) {
  grid.textContent = ''
  for (const target of targets) grid.appendChild(makeSlot(target, options))
}

function range (from, to, kind = 'player') {
  const out = []
  for (let slot = from; slot <= to; slot++) out.push({ kind, slot })
  return out
}

function setCaption (box, item) {
  box.textContent = ''
  if (!item) return
  const title = itemName(item) + (item.c > 1 ? ` ×${item.c}` : '')
  box.appendChild(el('span', 'name', title))
  const lore = (item.lore || []).slice(0, 2).join(' · ')
  if (lore) box.appendChild(el('span', 'lore', lore))
}

function renderEmpty () {
  const play = document.getElementById('play')
  const session = store.session()
  const box = document.getElementById('empty-play')
  const title = document.getElementById('empty-title')
  const text = document.getElementById('empty-text')
  const button = document.getElementById('empty-setup')
  let empty = false
  if (!session) {
    empty = true
    title.textContent = store.sessions.length ? 'Choose a session' : 'Start a session'
    text.textContent = 'Add a Minecraft account and a server in Setup, then start a session. Your bot stays connected when you close this page.'
    button.textContent = 'Open setup'
    button.dataset.action = 'setup'
  } else if (session.state === 'stopped') {
    empty = true
    title.textContent = sessionStatus(session)
    text.textContent = session.detail || 'The bot is not connected. Start it again when you’re ready.'
    button.textContent = 'Start session'
    button.dataset.action = 'start'
  }
  box.classList.toggle('hidden', !empty)
  play.classList.toggle('no-session', empty)
}

function renderStatusCard () {
  const session = store.session()
  const server = serverFor(session)
  document.getElementById('hb-dot').className = dotClass(session)
  document.getElementById('hb-time').textContent = sessionStatus(session)
  const sub = []
  if (server) sub.push(server.host + (server.port && server.port !== 25565 ? `:${server.port}` : ''))
  if (store.status?.ping != null && session?.state === 'online') sub.push(`ping ${store.status.ping} ms`)
  document.getElementById('hb-sub').textContent = sub.join(', ')
  const afk = document.getElementById('hb-afk')
  const on = server?.antiAfk?.enabled === true
  afk.setAttribute('aria-checked', String(on))
  afk.disabled = !server
  document.getElementById('hb-afk-label').textContent = on ? `Anti-AFK every ${server.antiAfk.intervalSec || 90} s` : 'Anti-AFK off'
  const alert = session?.lastAlert
  document.getElementById('hb-alert').textContent = alert ? alert.text : 'No alerts yet'
  document.getElementById('hb-alert-time').textContent = alert ? clock(alert.at) : ''
}

function renderCursor () {
  const banner = document.getElementById('cursor-banner')
  const cursor = store.cursor
  banner.classList.toggle('hidden', !cursor)
  if (!cursor) return
  const slot = document.getElementById('cursor-slot')
  slot.textContent = ''
  slot.appendChild(itemTile(cursor))
  document.getElementById('cursor-text').textContent = `Holding ${itemName(cursor)}${cursor.c > 1 ? ` ×${cursor.c}` : ''}. Click a slot to put it down.`
}

function renderWindow () {
  const panel = document.getElementById('window-panel')
  const w = store.window
  document.getElementById('play').classList.toggle('has-window', Boolean(w))
  panel.classList.toggle('hidden', !w)
  if (!w) return
  const title = w.title?.plain?.trim() || w.type.replace(/^minecraft:/, '').replace(/_/g, ' ')
  document.getElementById('window-title').textContent = title
  const grid = document.getElementById('window-grid')
  grid.style.setProperty('--cols', String(containerColumns(w.type)))
  fillGrid(grid, range(0, Math.max(0, (w.invStart ?? w.size) - 1), 'win'))
}

function renderPlayer () {
  const armor = document.getElementById('armor-row')
  armor.textContent = ''
  ARMOR_SLOTS.forEach((slot, i) => armor.appendChild(makeSlot({ kind: 'player', slot }, { ghost: true, label: ARMOR_NAMES[i].toLowerCase() })))
  armor.appendChild(makeSlot({ kind: 'player', slot: OFFHAND }, { ghost: true, label: 'offhand' }))
  armor.appendChild(el('span', 'gap', store.window ? 'Armor is in your inventory' : ''))
  for (const cell of armor.querySelectorAll('.slot')) cell.disabled = Boolean(store.window)
  fillGrid(document.getElementById('pack-grid'), range(9, 35))
  fillGrid(document.getElementById('hotbar-grid'), range(36, 44))
  let used = 0
  for (let slot = 9; slot <= 35; slot++) if (playerItem(slot)) used++
  document.getElementById('pack-count').textContent = `27 slots, ${used} used`
  renderSelection()
}

function renderSelection () {
  const quick = store.status?.quick
  for (const cell of document.querySelectorAll('#hotbar-grid .slot')) {
    cell.classList.toggle('sel', Number(cell.dataset.slot) - 36 === quick)
  }
  document.getElementById('hotbar-hint').textContent = store.window ? '' : 'Tap the selected slot again to use it'
}

let lastHeldKey = null
function renderHeld () {
  const quick = store.status?.quick
  const item = quick == null ? null : playerItem(36 + quick)
  const key = `${quick}|${item ? `${item.n}|${item.c}|${item.cn}|${(item.lore || []).join()}` : ''}|${store.textures.join()}`
  if (key !== lastHeldKey) {
    lastHeldKey = key
    const slot = document.getElementById('held-slot')
    slot.textContent = ''
    if (item) slot.appendChild(itemTile(item))
    document.getElementById('held-name').textContent = item ? itemName(item) : 'Nothing'
    document.getElementById('held-lore').textContent = (item?.lore || [])[0] || ''
    document.getElementById('held-slot-label').textContent = quick == null ? '' : `Slot ${quick + 1}`
  }
  const target = store.status?.target
  document.getElementById('held-target').textContent = target?.name ? `Looking at: ${target.name}` : ''
  const ok = online()
  document.getElementById('btn-use').disabled = !ok
  document.getElementById('btn-interact').disabled = !ok
}

export function renderPlay () {
  renderEmpty()
  renderStatusCard()
  renderCursor()
  renderWindow()
  renderPlayer()
  renderHeld()
  document.getElementById('pack-panel').classList.toggle('open', packOpen)
  document.getElementById('pack-toggle').setAttribute('aria-expanded', String(packOpen))
}

// --- tooltip and menu --------------------------------------------------------
function tooltipFor (item, x, y) {
  const tip = document.getElementById('tooltip')
  tip.textContent = ''
  tip.appendChild(el('div', `name${item.ench ? ' ench' : ''}`, itemName(item) + (item.c > 1 ? ` ×${item.c}` : '')))
  for (const line of (item.lore || []).slice(0, 8)) tip.appendChild(el('div', 'lore', line))
  if (item.dur && item.dur[1]) tip.appendChild(el('div', 'meta', `Durability ${item.dur[1] - item.dur[0]} / ${item.dur[1]}`))
  if (item.cn && item.d && item.cn !== item.d) tip.appendChild(el('div', 'meta', item.d))
  const hint = el('div', 'tip-hint')
  hint.append(el('span', '', 'Click: left'), el('span', '', 'Right-click: right'), el('span', '', 'Shift-click: quick move'), el('span', '', 'Q: drop'))
  tip.appendChild(hint)
  tip.classList.remove('hidden')
  placeFloating(tip, x + 16, y + 16)
}

function hideTooltip () {
  document.getElementById('tooltip').classList.add('hidden')
}

function placeFloating (node, x, y) {
  const rect = node.getBoundingClientRect()
  const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8)
  const top = y + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height - 24) : y
  node.style.left = `${left}px`
  node.style.top = `${top}px`
}

function menuItem (menu, text, action, quiet = false, shortcut = '') {
  const button = el('button', `m-item${quiet ? ' quiet' : ''}`, text)
  button.type = 'button'
  button.setAttribute('role', 'menuitem')
  if (shortcut) button.appendChild(el('span', 's', shortcut))
  button.addEventListener('click', () => {
    closeMenu()
    action()
  })
  menu.appendChild(button)
}

function openMenu (target, cell) {
  const menu = document.getElementById('slot-menu')
  const item = itemAt(target)
  menu.textContent = ''
  menuFor = target
  if (item) {
    const head = el('div', 'm-head')
    head.appendChild(el('div', 'name', itemName(item) + (item.c > 1 ? ` ×${item.c}` : '')))
    const lore = (item.lore || []).slice(0, 2).join(' · ')
    if (lore) head.appendChild(el('div', 'lore', lore))
    menu.appendChild(head)
  }
  const i = hotbarIndex(target)
  if (i !== null && !store.window) {
    if (store.status?.quick === i) menuItem(menu, 'Use item', useItem)
    else menuItem(menu, 'Hold this', () => selectHotbar(i))
  }
  menuItem(menu, 'Left click', () => click(target, 0, 0))
  menuItem(menu, 'Right click', () => click(target, 1, 0))
  if (store.features.clickModes?.includes('shift')) menuItem(menu, 'Shift-click', () => click(target, 0, 1))
  if (item && !store.cursor) {
    menuItem(menu, 'Drop one', () => drop(target, false), true)
    if (item.c > 1) menuItem(menu, 'Drop stack', () => drop(target, true), true)
  }
  menu.classList.remove('hidden')
  const rect = cell.getBoundingClientRect()
  placeFloating(menu, rect.left + rect.width / 2 - 40, rect.bottom + 6)
  menu.querySelector('.m-item')?.focus({ preventScroll: true })
}

export function closeMenu () {
  document.getElementById('slot-menu').classList.add('hidden')
  menuFor = null
}

export function menuOpen () {
  return menuFor !== null
}

// --- input -----------------------------------------------------------------
function targetOf (cell) {
  return { kind: cell.dataset.kind, slot: Number(cell.dataset.slot) }
}

function noteTouched (target) {
  const caption = document.getElementById(target.kind === 'win' ? 'window-caption' : 'slot-caption')
  setCaption(caption, itemAt(target))
}

function initPointer (root) {
  root.addEventListener('contextmenu', event => {
    if (event.target.closest('.slot[data-slot]')) event.preventDefault()
  })
  root.addEventListener('pointerdown', event => {
    const cell = event.target.closest('.slot[data-slot]')
    if (!cell || cell.disabled) return
    const target = targetOf(cell)
    if (event.pointerType === 'mouse') {
      // Mouse clicks act on press, like the game.
      if (event.button === 0) {
        event.preventDefault()
        if (event.shiftKey && store.features.clickModes?.includes('shift')) click(target, 0, 1)
        else primary(target)
      } else if (event.button === 2) {
        event.preventDefault()
        click(target, 1, 0)
      }
      return
    }
    if (press) return
    cell.classList.add('press')
    press = {
      id: event.pointerId,
      cell,
      target,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        if (!press || press.cell !== cell) return
        press.long = true
        cell.classList.remove('press')
        if (navigator.vibrate) {
          try { navigator.vibrate(15) } catch {}
        }
        noteTouched(target)
        openMenu(target, cell)
      }, LONG_PRESS_MS)
    }
  })
  const end = event => {
    if (!press || event.pointerId !== press.id) return
    const done = press
    press = null
    clearTimeout(done.timer)
    done.cell.classList.remove('press')
    if (event.type === 'pointerup' && !done.long && !done.moved) {
      noteTouched(done.target)
      primary(done.target)
    }
  }
  root.addEventListener('pointermove', event => {
    if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
      press.moved = true
      clearTimeout(press.timer)
      press.cell.classList.remove('press')
    }
    if (event.pointerType !== 'mouse') return
    const cell = event.target.closest('.slot[data-slot]')
    if (!cell) {
      if (hovered) {
        hovered = null
        hideTooltip()
      }
      return
    }
    hovered = targetOf(cell)
    const item = itemAt(hovered)
    if (item && !menuFor) tooltipFor(item, event.clientX, event.clientY)
    else hideTooltip()
  })
  root.addEventListener('pointerup', end)
  root.addEventListener('pointercancel', end)
  root.addEventListener('pointerleave', event => {
    if (event.pointerType === 'mouse') {
      hovered = null
      hideTooltip()
    }
  })
}

// Game-style keys on desktop: 1–9 pick a hotbar slot, E uses the held item,
// F interacts with the block in view, Q drops the hovered item, Esc closes.
export function playKey (event) {
  if (event.ctrlKey && event.code !== 'KeyQ') return false
  if (event.metaKey || event.altKey || isTypingTarget(event.target)) return false
  if (/^Digit[1-9]$/.test(event.code)) {
    selectHotbar(Number(event.code.slice(5)) - 1)
    return true
  }
  if (event.code === 'KeyE' && !event.repeat) {
    useItem()
    return true
  }
  if (event.code === 'KeyF' && !event.repeat) {
    interact()
    return true
  }
  if (event.code === 'KeyQ' && hovered && !event.repeat) {
    drop(hovered, event.ctrlKey)
    return true
  }
  return false
}

export function initPlay () {
  initPointer(document.getElementById('play'))
  document.addEventListener('pointerdown', event => {
    if (menuFor && !event.target.closest('#slot-menu')) closeMenu()
  }, true)
  document.getElementById('view-play').addEventListener('scroll', () => {
    closeMenu()
    hideTooltip()
  }, { passive: true })
  document.getElementById('close-window').addEventListener('click', closeWindow)
  document.getElementById('btn-use').addEventListener('click', useItem)
  document.getElementById('btn-interact').addEventListener('click', interact)
  document.getElementById('hb-afk').addEventListener('click', event => {
    setAntiAfk(event.currentTarget.getAttribute('aria-checked') !== 'true')
  })
  document.getElementById('pack-toggle').addEventListener('click', () => {
    packOpen = !packOpen
    renderPlay()
  })
  document.getElementById('empty-setup').addEventListener('click', event => {
    const session = store.session()
    if (event.currentTarget.dataset.action === 'start' && session) {
      send({ t: 'session.start', account: session.account, server: session.server })
    } else {
      window.dispatchEvent(new CustomEvent('golemlink-view', { detail: 'setup' }))
    }
  })

  const all = () => {
    closeMenu()
    hideTooltip()
    document.getElementById('slot-caption').textContent = ''
    document.getElementById('window-caption').textContent = ''
    lastHeldKey = null
    renderPlay()
  }
  store.on('snapshot', all)
  store.on('session', all)
  store.on('window', () => {
    closeMenu()
    hideTooltip()
    document.getElementById('window-caption').textContent = ''
    renderPlay()
  })
  store.on('inv', () => {
    if (menuFor && !itemAt(menuFor) && !store.cursor) closeMenu()
    renderCursor()
    renderWindow()
    renderPlayer()
    lastHeldKey = null
    renderHeld()
  })
  let lastQuick = null
  store.on('status', () => {
    if (store.status?.quick !== lastQuick) {
      lastQuick = store.status?.quick
      document.getElementById('slot-caption').textContent = ''
      renderSelection()
    }
    renderHeld()
  })
  onTexturesLoaded(() => {
    lastHeldKey = null
    renderPlay()
  })
  for (const event of ['sessions', 'servers', 'hello', 'connection', 'alert']) store.on(event, () => {
    renderEmpty()
    renderStatusCard()
    renderHeld()
  })
  setInterval(renderStatusCard, 15000)
  renderPlay()
}
