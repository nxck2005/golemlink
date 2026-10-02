import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { normalizeComponentText } from './protocol.js'

const require = createRequire(import.meta.url)

// prismarine-chat is part of mineflayer's dependency tree. Resolve it through
// mineflayer so the daemon and the bot use exactly the same copy.
function loadChatClass () {
  const mineflayerEntry = require.resolve('mineflayer')
  const req = createRequire(mineflayerEntry)
  return req('prismarine-chat')
}

const COLOR_HEX = {
  black: '#000000',
  dark_blue: '#0000aa',
  dark_green: '#00aa00',
  dark_aqua: '#00aaaa',
  dark_red: '#aa0000',
  dark_purple: '#aa00aa',
  gold: '#ffaa00',
  gray: '#aaaaaa',
  dark_gray: '#555555',
  blue: '#5555ff',
  green: '#55ff55',
  aqua: '#55ffff',
  red: '#ff5555',
  light_purple: '#ff55ff',
  yellow: '#ffff55',
  white: '#ffffff'
}

export function colorToHex (color) {
  if (typeof color !== 'string') return undefined
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase()
  return COLOR_HEX[color]
}

function deriveStyle (message, inherited) {
  const style = { ...inherited }
  const color = colorToHex(message.color)
  if (color) style.c = color
  for (const [key, flag] of [['bold', 'b'], ['italic', 'i'], ['underlined', 'u'], ['strikethrough', 's'], ['obfuscated', 'o']]) {
    if (message[key] !== undefined) {
      if (message[key]) style[flag] = 1
      else delete style[flag]
    }
  }
  return style
}

function pushText (segs, text, style) {
  if (!text) return
  const seg = { x: String(text) }
  if (style.c) seg.c = style.c
  if (style.b) seg.b = 1
  if (style.i) seg.i = 1
  if (style.u) seg.u = 1
  if (style.s) seg.s = 1
  if (style.o) seg.o = 1
  segs.push(seg)
}

function renderTranslate (message, style, language) {
  const template = (language && language[message.translate]) || message.fallback || message.translate
  const args = Array.isArray(message.with) ? message.with : []
  const segs = []
  let last = 0
  let sequential = 0
  const re = /%(\d+\$)?[sSdDfF]/g
  let match
  while ((match = re.exec(template)) !== null) {
    if (match.index > last) pushText(segs, template.slice(last, match.index), style)
    let index = sequential++
    if (match[1]) index = parseInt(match[1], 10) - 1
    const arg = args[index]
    if (arg !== undefined) segs.push(...renderNode(arg, style, language))
    last = match.index + match[0].length
  }
  if (last < template.length) pushText(segs, template.slice(last), style)
  return segs
}

function renderNode (message, inherited, language) {
  if (message === null || message === undefined) return []
  if (typeof message === 'string' || typeof message === 'number') {
    const segs = []
    pushText(segs, String(message), inherited)
    return segs
  }
  const style = deriveStyle(message, inherited)
  const segs = []
  if (typeof message.translate === 'string') {
    segs.push(...renderTranslate(message, style, language))
  } else if (typeof message.text === 'string' || typeof message.text === 'number') {
    pushText(segs, String(message.text), style)
  } else if (typeof message.selector === 'string') {
    pushText(segs, message.selector, style)
  } else if (typeof message.keybind === 'string') {
    pushText(segs, message.keybind, style)
  } else if (message.score) {
    pushText(segs, JSON.stringify(message.score), style)
  }
  if (Array.isArray(message.extra)) {
    for (const extra of message.extra) segs.push(...renderNode(extra, style, language))
  }
  return segs
}

// Build {plain, segs} from a prismarine-chat Message instance.
export function messageToSegs (message, language) {
  const languageTable = language || message?.constructor?.language || null
  let segs
  try {
    segs = renderNode(message, {}, languageTable)
  } catch {
    segs = []
  }
  if (segs.length === 0) {
    let plain = ''
    try {
      plain = message.toString()
    } catch {}
    return { plain, segs: plain ? [{ x: plain }] : [] }
  }
  return { plain: segs.map(s => s.x).join(''), segs }
}

export function componentToPlain (raw, registry) {
  try {
    const ChatMessage = loadChatClass()(registry)
    return new ChatMessage(raw).toString()
  } catch {
    return normalizeComponentText(raw, null).plain
  }
}

export function makeChatMessage (raw, registry) {
  const ChatMessage = loadChatClass()(registry)
  return new ChatMessage(raw)
}

export class ChatLog {
  constructor ({ sessionId, dataDir, chatLog, registry, logger }) {
    this.sessionId = sessionId
    this.dataDir = dataDir
    this.fileLog = chatLog !== false
    this.registry = registry
    this.logger = logger
    this.lines = []
    this.maxLines = 500
    this.passwords = []
    this.currentDate = null
    this.file = null
  }

  setPasswords (passwords) {
    this.passwords = (passwords || []).filter(p => typeof p === 'string' && p.length > 0)
  }

  redact (text) {
    let out = String(text)
    for (const password of this.passwords) out = out.split(password).join('••••')
    return out
  }

  buildLine (message, position, sender) {
    const { plain, segs } = messageToSegs(message, this.registry?.language)
    const redacted = this.redact(plain)
    const safeSegs = segs.map(seg => ({ ...seg, x: this.redact(seg.x) }))
    return {
      ts: Date.now(),
      plain: redacted,
      segs: safeSegs,
      position: position || 'chat',
      sender: typeof sender === 'string' ? sender : sender?.name || null
    }
  }

  // Store and return the line. `echo` marks our own outgoing chat.
  add (message, position, sender, { echo = false } = {}) {
    const line = this.buildLine(message, position, sender)
    if (echo) line.echo = true
    this.lines.push(line)
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines)
    if (this.fileLog) this.appendFile(line)
    return line
  }

  backlog () {
    return this.lines.slice()
  }

  appendFile (line) {
    try {
      const date = new Date(line.ts).toISOString().slice(0, 10)
      if (date !== this.currentDate) {
        const dir = path.join(this.dataDir, 'logs', this.sessionId)
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        const file = path.join(dir, `${date}.jsonl`)
        if (this.file !== file) {
          this.file = file
          this.currentDate = date
        }
      }
      const record = { ...line }
      delete record.segs
      delete record.position
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 })
    } catch (err) {
      if (!this.fileErrorLogged) {
        this.fileErrorLogged = true
        this.logger?.warn?.(`chat log write failed for ${this.sessionId}: ${err.message}`)
      }
    }
  }
}

export function validateChatText (text, { oldLimit = false } = {}) {
  const limit = oldLimit ? 100 : 256
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, code: 'empty', msg: 'message is empty' }
  }
  if (text.length > limit) {
    return { ok: false, code: 'too_long', msg: `message is ${text.length} characters; this server allows at most ${limit}` }
  }
  if (/[\u0000-\u001f\u007f\u00a7]/.test(text)) {
    return { ok: false, code: 'illegal_characters', msg: 'message contains control characters or § that the server rejects' }
  }
  return { ok: true }
}

// Simple token bucket, 4 requests/second with a burst of 4.
export function createRateLimiter ({ rate = 4, burst = 4 } = {}) {
  let tokens = burst
  let last = Date.now()
  return function tryConsume () {
    const now = Date.now()
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate)
    last = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}
