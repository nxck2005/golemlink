import { messageToSegs, chatClass, colorToHex } from './chat.js'

// What the server shows around the game view: the sidebar scoreboard, boss
// bars and the tab list header and footer. Mineflayer's own scoreboard
// tracking misses scores on 1.20.3+ (those packets have no action field) and
// drops colours from titles, so this reads the raw packets.

const LEGACY_COLORS = {
  0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua', 4: 'dark_red', 5: 'dark_purple', 6: 'gold', 7: 'gray',
  8: 'dark_gray', 9: 'blue', a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white'
}
const LEGACY_FLAGS = { k: 'o', l: 'b', m: 's', n: 'u', o: 'i' }
const TEAM_COLORS = ['black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray',
  'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white']
const SIDEBAR = 1
const MAX_LINES = 15
const MAX_TEXT = 200

// Plugins still put § codes inside component text. Split them into styled
// segments so the web client only ever deals with segs.
export function expandLegacy (segs) {
  const out = []
  for (const seg of segs) {
    if (!seg.x.includes('§')) {
      out.push(seg)
      continue
    }
    let style = { ...seg }
    delete style.x
    const parts = seg.x.split('§')
    if (parts[0]) out.push({ ...style, x: parts[0] })
    for (const part of parts.slice(1)) {
      const code = part.charAt(0).toLowerCase()
      if (LEGACY_COLORS[code]) {
        style = { c: colorToHex(LEGACY_COLORS[code]) }
      } else if (LEGACY_FLAGS[code]) {
        style = { ...style, [LEGACY_FLAGS[code]]: 1 }
      } else if (code === 'r') {
        style = {}
      }
      const text = part.slice(code ? 1 : 0)
      if (text) out.push({ ...style, x: text })
    }
  }
  return out
}

function clip (segs) {
  let left = MAX_TEXT
  const out = []
  for (const seg of segs) {
    if (left <= 0) break
    const x = seg.x.length > left ? seg.x.slice(0, left) : seg.x
    left -= x.length
    out.push(x === seg.x ? seg : { ...seg, x })
  }
  return out
}

export function toSegs (message) {
  if (message === null || message === undefined) return []
  try {
    return clip(expandLegacy(messageToSegs(message).segs))
  } catch {
    return []
  }
}

export function isBlank (segs) {
  return !segs.some(seg => seg.x.trim())
}

export class Board {
  constructor ({ bot, send, intervalMs = 250 }) {
    this.bot = bot
    this.send = send
    this.objectives = new Map() // name -> { title, format }
    this.scores = new Map() // objective -> Map(entity -> { value, name, format })
    this.slots = new Map() // display slot -> objective name
    this.dirty = true
    this.last = ''
    this.listeners = []
    this.timer = setInterval(() => this.flush(), intervalMs)
    this.timer.unref?.()
  }

  attach () {
    const client = this.bot._client
    const on = (target, name, fn) => {
      target.on(name, fn)
      this.listeners.push([target, name, fn])
    }
    const mark = () => { this.dirty = true }
    on(client, 'scoreboard_objective', packet => this.onObjective(packet))
    on(client, 'scoreboard_score', packet => this.onScore(packet))
    on(client, 'reset_score', packet => this.onReset(packet))
    on(client, 'scoreboard_display_objective', packet => this.onDisplay(packet))
    on(client, 'teams', mark)
    on(client, 'playerlist_header', mark)
    for (const event of ['bossBarCreated', 'bossBarDeleted', 'bossBarUpdated']) on(this.bot, event, mark)
  }

  detach () {
    for (const [target, name, fn] of this.listeners) target.removeListener(name, fn)
    this.listeners = []
    clearInterval(this.timer)
  }

  message (raw) {
    if (raw === undefined || raw === null) return null
    if (typeof raw === 'string' && !raw) return null
    try {
      return chatClass(this.bot.registry).fromNotch(raw)
    } catch {
      return null
    }
  }

  format (kind, styling) {
    if (kind === undefined || kind === null) return null
    if (kind === 0) return { kind: 'blank' }
    const message = this.message(styling)
    if (kind === 2) return { kind: 'fixed', segs: toSegs(message) }
    return { kind: 'styled', c: colorToHex(message?.color) }
  }

  onObjective (packet) {
    if (packet.action === 1) {
      this.objectives.delete(packet.name)
      this.scores.delete(packet.name)
    } else {
      const previous = this.objectives.get(packet.name)
      this.objectives.set(packet.name, {
        title: toSegs(this.message(packet.displayText)),
        format: packet.number_format === undefined ? previous?.format ?? null : this.format(packet.number_format, packet.styling)
      })
      if (!this.scores.has(packet.name)) this.scores.set(packet.name, new Map())
    }
    this.dirty = true
  }

  onScore (packet) {
    const objective = packet.scoreName
    if (packet.action === 1) {
      if (objective && this.scores.has(objective)) this.scores.get(objective).delete(packet.itemName)
      else for (const scores of this.scores.values()) scores.delete(packet.itemName)
    } else {
      if (!this.scores.has(objective)) this.scores.set(objective, new Map())
      this.scores.get(objective).set(packet.itemName, {
        value: packet.value,
        name: packet.display_name === undefined ? null : toSegs(this.message(packet.display_name)),
        format: this.format(packet.number_format, packet.styling)
      })
    }
    this.dirty = true
  }

  onReset (packet) {
    if (packet.objective_name) this.scores.get(packet.objective_name)?.delete(packet.entity_name)
    else for (const scores of this.scores.values()) scores.delete(packet.entity_name)
    this.dirty = true
  }

  onDisplay (packet) {
    if (packet.name) this.slots.set(packet.position, packet.name)
    else this.slots.delete(packet.position)
    this.dirty = true
  }

  team (name) {
    const map = this.bot.teamMap
    return map && Object.hasOwn(map, name) ? map[name] : null
  }

  // Vanilla shows the sidebar for your own team colour over the plain one.
  sidebarName () {
    const team = this.team(this.bot.username)
    const index = team ? TEAM_COLORS.indexOf(team.color) : -1
    if (index >= 0 && this.slots.has(3 + index)) return this.slots.get(3 + index)
    return this.slots.get(SIDEBAR)
  }

  entryName (entity, score) {
    if (score.name) return score.name
    const team = this.team(entity)
    if (team) return toSegs(team.displayName(entity))
    return expandLegacy([{ x: entity }])
  }

  sidebar () {
    const name = this.sidebarName()
    const objective = name && this.objectives.get(name)
    if (!objective) return null
    const entries = [...(this.scores.get(name) || new Map()).entries()]
      .sort((a, b) => b[1].value - a[1].value || a[0].localeCompare(b[0]))
      .slice(0, MAX_LINES)
    const lines = entries.map(([entity, score]) => {
      const line = { segs: this.entryName(entity, score) }
      const format = score.format || objective.format
      if (!format) line.score = String(score.value)
      else if (format.kind === 'styled') {
        line.score = String(score.value)
        if (format.c) line.sc = format.c
      } else if (format.kind === 'fixed' && !isBlank(format.segs)) line.scoreSegs = format.segs
      return line
    })
    return { title: objective.title, lines }
  }

  bars () {
    return (this.bot.bossBars || []).map(bar => ({
      id: String(bar.entityUUID),
      segs: typeof bar.title === 'string' ? expandLegacy([{ x: bar.title }]) : toSegs(bar.title),
      health: Math.max(0, Math.min(1, Number(bar.health) || 0)),
      color: bar.color || 'white'
    }))
  }

  tab () {
    const tablist = this.bot.tablist
    return { header: toSegs(tablist?.header), footer: toSegs(tablist?.footer) }
  }

  payload () {
    return { sidebar: this.sidebar(), bars: this.bars(), tab: this.tab() }
  }

  flush (force = false) {
    if (!this.dirty && !force) return
    this.dirty = false
    let payload
    try {
      payload = this.payload()
    } catch {
      return
    }
    const text = JSON.stringify(payload)
    if (text === this.last && !force) return
    this.last = text
    this.send(payload)
  }
}
