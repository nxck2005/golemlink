import { store } from './store.js'
import { send } from './net.js'
import { itemTile, itemLabel } from './items.js'

let detailsMode = false
let openWindowBox, windowTitle, windowGrid, invGrid, hotbarGrid, armorGrid, cursorBanner, cursorItem, closeWindowButton

const CONTAINER_COLUMNS = [
  [/hopper/, 5],
  [/dispenser|dropper|anvil|grindstone|smithing|furnace|blast_furnace|smoker|cartography|stonecutter|beacon/, 3],
  [/brewing/, 5],
  [/loom|enchantment/, 4],
  [/merchant/, 3]
]

function containerColumns (type) {
  for (const [pattern, columns] of CONTAINER_COLUMNS) {
    if (pattern.test(type || '')) return columns
  }
  return 9
}

function playerItem (slot) {
  if (store.window) {
    const w = store.window
    if (slot >= 9 && slot <= 44) {
      const mapped = w.invStart + (slot - 9)
      return w.slots?.[mapped] ?? null
    }
  }
  return store.inventory?.slots?.[slot] ?? null
}

function clickTarget (slot) {
  if (store.window && slot >= 9 && slot <= 44) {
    return { windowId: store.window.id, slot: store.window.invStart + (slot - 9) }
  }
  return { windowId: 0, slot }
}

function sendClick (target, button, mode = 0) {
  send({ t: 'click', s: store.sessionId, window: target.windowId, slot: target.slot, button, mode })
}

function makeCell ({ item, windowId, slot, extraClass = '' }) {
  const cell = document.createElement('button')
  cell.type = 'button'
  cell.className = `cell ${extraClass}`.trim()
  if (item) {
    cell.appendChild(itemTile(item))
    cell.title = itemLabel(item)
  }
  let pressTimer = null
  let longPressed = false
  let moved = false
  let start = null
  cell.addEventListener('pointerdown', event => {
    event.preventDefault()
    cell.setPointerCapture(event.pointerId)
    longPressed = false
    moved = false
    start = { x: event.clientX, y: event.clientY }
    pressTimer = setTimeout(() => {
      longPressed = true
      if (detailsMode) openDetail(item, { windowId, slot })
      else if (item) sendClick({ windowId, slot }, 1, 0)
    }, 500)
  })
  cell.addEventListener('pointermove', event => {
    if (!start) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) {
      moved = true
      clearTimeout(pressTimer)
    }
  })
  cell.addEventListener('pointerup', event => {
    clearTimeout(pressTimer)
    if (moved || longPressed) return
    if (detailsMode) {
      if (item) openDetail(item, { windowId, slot })
      return
    }
    if (item || windowId !== 0) sendClick({ windowId, slot }, 0, 0)
  })
  cell.addEventListener('pointercancel', () => clearTimeout(pressTimer))
  cell.addEventListener('contextmenu', event => event.preventDefault())
  return cell
}

function renderWindow () {
  windowGrid.textContent = ''
  if (!store.window) return
  const columns = containerColumns(store.window.type)
  windowGrid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`
  const count = store.window.invStart
  for (let slot = 0; slot < count; slot++) {
    windowGrid.appendChild(makeCell({ item: store.window.slots?.[slot], windowId: store.window.id, slot }))
  }
}

function renderPlayer () {
  invGrid.textContent = ''
  hotbarGrid.textContent = ''
  armorGrid.textContent = ''
  for (let slot = 5; slot <= 8; slot++) armorGrid.appendChild(makeCell({ item: playerItem(slot), ...clickTarget(slot) }))
  armorGrid.appendChild(makeCell({ item: playerItem(45), ...clickTarget(45) }))
  for (let slot = 9; slot <= 35; slot++) invGrid.appendChild(makeCell({ item: playerItem(slot), ...clickTarget(slot) }))
  const quick = store.status?.quick
  for (let slot = 36; slot <= 44; slot++) {
    const cell = makeCell({ item: playerItem(slot), ...clickTarget(slot), extraClass: quick === slot - 36 ? 'active-slot' : '' })
    hotbarGrid.appendChild(cell)
  }
}

export function renderBag () {
  if (!openWindowBox) return
  const hasWindow = Boolean(store.window)
  openWindowBox.classList.toggle('hidden', !hasWindow)
  closeWindowButton.classList.toggle('hidden', !hasWindow)
  if (hasWindow) {
    windowTitle.textContent = store.window.title?.plain || store.window.type
    renderWindow()
  } else {
    windowGrid.textContent = ''
  }
  renderPlayer()
  if (store.cursor) {
    cursorBanner.classList.remove('hidden')
    cursorItem.textContent = itemLabel(store.cursor)
  } else {
    cursorBanner.classList.add('hidden')
  }
}

function actionButton (label, handler, disabled = false) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn'
  button.textContent = label
  button.disabled = disabled
  button.addEventListener('click', handler)
  return button
}

function openDetail (item, { windowId, slot }) {
  const body = document.getElementById('sheet-body')
  body.textContent = ''
  const title = document.createElement('h3')
  title.textContent = item ? item.d || item.n : 'Empty slot'
  body.appendChild(title)
  if (item) {
    const meta = document.createElement('div')
    meta.className = 'small muted mono'
    const bits = [item.n]
    if (item.c > 1) bits.push(`×${item.c}`)
    if (item.dur) bits.push(`${item.dur[1] - item.dur[0]}/${item.dur[1]}`)
    if (item.ench) bits.push('enchanted')
    meta.textContent = bits.join(' · ')
    body.appendChild(meta)
    if (item.cn && item.cn !== item.d) {
      const custom = document.createElement('div')
      custom.className = 'small'
      custom.textContent = `Custom name: ${item.cn}`
      body.appendChild(custom)
    }
    if (item.lore && item.lore.length > 0) {
      const lore = document.createElement('div')
      lore.className = 'lore'
      lore.textContent = item.lore.join('\n')
      body.appendChild(lore)
    }
  }
  const actions = document.createElement('div')
  actions.className = 'actions'
  if (item) {
    const inHotbar = [36, 37, 38, 39, 40, 41, 42, 43, 44].find(slotIndex => {
      const candidate = playerItem(slotIndex)
      return candidate && candidate.n === item.n && candidate.cn === item.cn
    })
    actions.appendChild(actionButton('Hold', () => {
      if (inHotbar !== undefined) send({ t: 'hotbar', s: store.sessionId, i: inHotbar - 36 })
      closeSheet()
    }, inHotbar === undefined))
    actions.appendChild(actionButton('Drop one', () => {
      send({ t: 'drop', s: store.sessionId, slot, all: false })
      closeSheet()
    }))
    actions.appendChild(actionButton('Drop stack', () => {
      send({ t: 'drop', s: store.sessionId, slot, all: true })
      closeSheet()
    }))
    actions.appendChild(actionButton('Use', () => {
      if (inHotbar !== undefined) send({ t: 'hotbar', s: store.sessionId, i: inHotbar - 36 })
      setTimeout(() => send({ t: 'use', s: store.sessionId }), 120)
      closeSheet()
    }, inHotbar === undefined))
    if (windowId !== undefined && windowId !== 0 && windowId === store.window?.id) {
      actions.appendChild(actionButton('Shift-click', () => {
        sendClick({ windowId, slot }, 0, 1)
        closeSheet()
      }))
    }
  }
  body.appendChild(actions)
  document.getElementById('sheet').classList.remove('hidden')
}

export function closeSheet () {
  document.getElementById('sheet').classList.add('hidden')
}

export function initBag () {
  openWindowBox = document.getElementById('open-window')
  windowTitle = document.getElementById('window-title')
  windowGrid = document.getElementById('window-grid')
  invGrid = document.getElementById('inv-grid')
  hotbarGrid = document.getElementById('hotbar-grid')
  armorGrid = document.getElementById('armor-row')
  cursorBanner = document.getElementById('cursor-banner')
  cursorItem = document.getElementById('cursor-item')
  closeWindowButton = document.getElementById('close-window')

  document.getElementById('details-toggle').addEventListener('click', event => {
    detailsMode = !detailsMode
    event.currentTarget.classList.toggle('active', detailsMode)
    event.currentTarget.textContent = detailsMode ? 'ⓘ Details mode on' : 'ⓘ Details mode'
  })
  closeWindowButton.addEventListener('click', () => send({ t: 'closeWindow', s: store.sessionId }))
  document.getElementById('sheet-close').addEventListener('click', closeSheet)

  store.on('snapshot', renderBag)
  store.on('inv', renderBag)
  store.on('window', renderBag)
  store.on('status', renderBag)
}
