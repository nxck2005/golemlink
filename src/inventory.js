import { makeChatMessage } from './chat.js'

// Plain text for any text component / legacy §-string / simplified NBT value.
export function textComponentToPlain (value, registry) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    if (value.length === 0) return ''
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return makeChatMessage(JSON.parse(trimmed), registry).toString()
      } catch {}
    }
    try {
      return makeChatMessage(value, registry).toString()
    } catch {
      return value
    }
  }
  if (typeof value === 'number') return String(value)
  try {
    return makeChatMessage(value, registry).toString()
  } catch {
    return null
  }
}

// Spec §8.5: custom_name, then item_name (plugin menus), then display name.
export function describeItem (item, registry) {
  if (!item) return null
  let name = null
  let customName = null
  try {
    if (item.componentMap?.has?.('custom_name')) customName = item.componentMap.get('custom_name').data
    else customName = item.customName
  } catch {}
  if (customName !== null && customName !== undefined) name = textComponentToPlain(customName, registry)
  if (!name) {
    const itemName = item.componentMap?.get?.('item_name')?.data
    if (itemName !== undefined) name = textComponentToPlain(itemName, registry)
  }
  if (!name) name = item.displayName || item.name || 'unknown'

  let lore = []
  try {
    const rawLore = item.customLore
    if (Array.isArray(rawLore)) lore = rawLore.map(entry => textComponentToPlain(entry, registry) ?? '').filter(l => l !== '')
    else if (rawLore) lore = [textComponentToPlain(rawLore, registry) ?? ''].filter(l => l !== '')
  } catch {}

  let dur = null
  try {
    let used = item.durabilityUsed
    if ((used === null || used === undefined) && item.componentMap?.has?.('damage')) {
      used = item.componentMap.get('damage').data
    }
    if (used !== null && used !== undefined && item.maxDurability) dur = [used, item.maxDurability]
  } catch {}

  let ench = false
  try {
    ench = Array.isArray(item.enchants) && item.enchants.length > 0
  } catch {}
  if (!ench && Array.isArray(item.componentMap?.get?.('enchantments')?.data)) {
    ench = item.componentMap.get('enchantments').data.length > 0
  }

  return { name, lore, dur, ench }
}

export function itemShape (item, registry) {
  if (!item) return null
  const info = describeItem(item, registry)
  return {
    n: item.name,
    d: info?.name || item.displayName || item.name || 'unknown',
    c: item.count,
    cn: info && info.name !== (item.displayName || item.name) ? info.name : null,
    lore: info?.lore || [],
    dur: info?.dur ?? null,
    ench: Boolean(info?.ench)
  }
}

export function windowShape (window, registry) {
  if (!window) return null
  let title = { plain: '', segs: [] }
  try {
    const parsed = makeChatMessage(window.title, registry).toString()
    title = { plain: parsed, segs: [{ x: parsed }] }
  } catch {
    title = { plain: String(window.title ?? ''), segs: [] }
  }
  return {
    id: window.id,
    type: String(window.type || 'minecraft:generic_9x3'),
    title,
    size: window.slots.length,
    invStart: window.inventoryStart,
    hotbarStart: window.hotbarStart,
    slots: window.slots.map(item => itemShape(item, registry))
  }
}

export function cursorShape (window, registry) {
  const item = window?.selectedItem
  return itemShape(item, registry)
}

// Mirrors bot inventory and the open window, and turns user clicks into
// mineflayer calls. All bot calls are promise-handled by the caller (session).
export class InventoryMirror {
  constructor ({ bot, registry, logger, sendToSubscribers, sessionId, debounceMs = 50 }) {
    this.bot = bot
    this.registry = registry
    this.logger = logger
    this.send = sendToSubscribers
    this.sessionId = sessionId
    this.debounceMs = debounceMs
    this.pending = new Map() // windowId -> Map(slot -> item|null)
    this.pendingCursor = undefined
    this.timer = null
    this.attached = new Map()
  }

  attach () {
    const bot = this.bot
    this.onOpen = window => this.handleOpen(window)
    this.onClose = window => this.handleClose(window)
    this.onHeldItemChanged = () => this.handleHeldItem()
    bot.on('windowOpen', this.onOpen)
    bot.on('windowClose', this.onClose)
    bot.on('heldItemChanged', this.onHeldItemChanged)
    this.attachWindow(bot.inventory)
    if (bot.currentWindow) this.attachWindow(bot.currentWindow)
  }

  detach () {
    const bot = this.bot
    bot.removeListener('windowOpen', this.onOpen)
    bot.removeListener('windowClose', this.onClose)
    bot.removeListener('heldItemChanged', this.onHeldItemChanged)
    for (const window of [...this.attached.keys()]) this.detachWindow(window)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  attachWindow (window) {
    if (!window || this.attached.has(window)) return
    const listener = (slot, oldItem, newItem) => this.queue(window.id, slot, newItem)
    this.attached.set(window, listener)
    window.on('updateSlot', listener)
  }

  detachWindow (window) {
    const listener = this.attached.get(window)
    if (!listener) return
    window.removeListener('updateSlot', listener)
    this.attached.delete(window)
  }

  handleOpen (window) {
    this.attachWindow(window)
    this.flush()
    this.send({ t: 'window', s: this.sessionId, window: windowShape(window, this.registry) })
  }

  handleClose (window) {
    this.detachWindow(window)
    this.flush()
    this.send({ t: 'window', s: this.sessionId, window: null })
  }

  handleHeldItem () {
    const start = this.bot.QUICK_BAR_START ?? 36
    this.queue(0, start + (this.bot.quickBarSlot || 0), this.bot.heldItem)
  }

  queue (windowId, slot, item) {
    let slots = this.pending.get(windowId)
    if (!slots) {
      slots = new Map()
      this.pending.set(windowId, slots)
    }
    slots.set(slot, itemShape(item, this.registry))
    if (windowId === 0) {
      // The player window is mirrored into any open window's inventory region
      // by prismarine-windows; forward those deltas for the open window too.
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.debounceMs)
    }
  }

  queueCursor (cursor) {
    this.pendingCursor = cursor
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.debounceMs)
    }
  }

  flush () {
    for (const [windowId, slots] of this.pending) {
      const payload = {}
      for (const [slot, item] of slots) payload[String(slot)] = item
      const msg = { t: 'inv', s: this.sessionId, window: windowId, slots: payload }
      if (this.pendingCursor !== undefined) {
        msg.cursor = this.pendingCursor
        this.pendingCursor = undefined
      }
      this.send(msg)
    }
    this.pending.clear()
  }

  snapshot () {
    const bot = this.bot
    const cursorWindow = bot.currentWindow || bot.inventory
    return {
      inventory: windowShape(bot.inventory, this.registry),
      window: windowShape(bot.currentWindow, this.registry),
      cursor: cursorShape(cursorWindow, this.registry)
    }
  }

  currentWindowId () {
    return this.bot.currentWindow ? this.bot.currentWindow.id : 0
  }

  validateClick ({ window: windowId, slot, button, mode }) {
    const expected = this.currentWindowId()
    if (windowId !== expected) {
      return { ok: false, code: 'stale_window', msg: `window ${windowId} is not open (current: ${expected})` }
    }
    const win = this.bot.currentWindow || this.bot.inventory
    const maxSlot = win.slots.length - 1
    if (slot !== -999 && (slot < 0 || slot > maxSlot)) {
      return { ok: false, code: 'bad_slot', msg: `slot ${slot} is outside the window (0-${maxSlot})` }
    }
    if (mode !== 0 && mode !== 1) {
      return { ok: false, code: 'unsupported_mode', msg: `click mode ${mode} is not supported` }
    }
    return { ok: true, win }
  }

  async click (params) {
    const result = this.validateClick(params)
    if (!result.ok) throw Object.assign(new Error(result.msg), { code: result.code })
    await this.bot.clickWindow(params.slot, params.button, params.mode)
    this.queueCursor(cursorShape(result.win, this.registry))
  }

  async drop (slot, all) {
    const win = this.bot.currentWindow || this.bot.inventory
    if (slot < 0 || slot >= win.slots.length) {
      throw Object.assign(new Error(`slot ${slot} is outside the window`), { code: 'bad_slot' })
    }
    if (win.selectedItem) {
      throw Object.assign(new Error('the cursor is holding an item'), { code: 'cursor_busy' })
    }
    await this.bot.clickWindow(slot, 0, 0)
    if (all) {
      await this.bot.clickWindow(-999, 0, 0)
    } else {
      await this.bot.clickWindow(-999, 1, 0)
      await this.bot.clickWindow(slot, 0, 0)
    }
    this.queueCursor(cursorShape(win, this.registry))
  }
}
