// Keyword / damage / death / kick / MSA alerts. Delivery goes to every
// connected UI plus (optionally) termux-notification. At most one alert per
// kind per 10 s, with counts coalesced.
const COOLDOWN_MS = 10 * 1000
const DAMAGE_COOLDOWN_MS = 15 * 1000
const SENT_MEMORY_MS = 5000

function escapeRegex (text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compileKeyword (keyword) {
  const match = /^\/(.+)\/([a-z]*)$/.exec(keyword)
  if (match) return new RegExp(match[1], match[2])
  return new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i')
}

export class Alerts {
  constructor ({ sessionId, serverId, server, termux, logger, broadcast }) {
    this.sessionId = sessionId
    this.serverId = serverId
    this.termux = termux
    this.logger = logger
    this.broadcast = broadcast
    this.keywords = []
    this.damageEnabled = true
    this.deathEnabled = true
    this.recentSent = []
    this.lastDamageAt = 0
    this.limits = new Map() // kind -> { last, pending, text, timer }
    this.botUsername = null
    this.configure(server)
  }

  configure (server) {
    const alerts = server?.alerts || {}
    this.keywords = (alerts.keywords || []).map(k => {
      try {
        return { raw: k, re: compileKeyword(k) }
      } catch {
        return null
      }
    }).filter(Boolean)
    this.damageEnabled = alerts.damage !== false
    this.deathEnabled = alerts.death !== false
  }

  noteSent (text) {
    this.recentSent.push({ text, at: Date.now() })
    if (this.recentSent.length > 16) this.recentSent.splice(0, this.recentSent.length - 16)
  }

  isOwnLine (line, sender) {
    if (line.echo) return true
    if (sender && this.botUsername && sender === this.botUsername) return true
    const now = Date.now()
    const text = line.plain || ''
    return this.recentSent.some(entry => now - entry.at < SENT_MEMORY_MS && text.includes(entry.text))
  }

  chat (line, sender) {
    if (this.keywords.length === 0) return
    if (this.isOwnLine(line, sender)) return
    for (const { raw, re } of this.keywords) {
      re.lastIndex = 0
      if (re.test(line.plain)) {
        this.fire('keyword', `"${raw}" mentioned: ${line.plain}`)
      }
    }
  }

  damage (before, after) {
    if (!this.damageEnabled) return
    if (typeof before !== 'number' || typeof after !== 'number') return
    if (after >= before) return
    const now = Date.now()
    if (this.lastDamageAt > 0 && now - this.lastDamageAt < DAMAGE_COOLDOWN_MS) return
    this.lastDamageAt = now
    this.fire('damage', `Took ${Math.round((before - after) * 10) / 10} damage (${after}/20)`)
  }

  death () {
    if (!this.deathEnabled) return
    this.fire('death', 'The bot died')
  }

  stopped (reason, detail) {
    this.fire('stopped', `Session ${this.sessionId} stopped: ${reason}${detail ? ` — ${detail}` : ''}`)
  }

  msa (code, url) {
    this.fire('msa', `Microsoft sign-in required: ${code} at ${url}`)
  }

  fire (kind, text) {
    const now = Date.now()
    let state = this.limits.get(kind)
    if (!state) {
      state = { last: -Infinity, pending: 0, text: '', timer: null }
      this.limits.set(kind, state)
    }
    if (state.timer) {
      state.pending++
      state.text = text
      return
    }
    if (now - state.last >= COOLDOWN_MS) {
      this.deliver(kind, text)
      state.last = now
      return
    }
    state.pending = 1
    state.text = text
    const wait = COOLDOWN_MS - (now - state.last)
    state.timer = setTimeout(() => {
      state.timer = null
      const count = state.pending
      state.pending = 0
      state.last = Date.now()
      const suffix = count > 1 ? ` (×${count})` : ''
      this.deliver(kind, state.text + suffix)
    }, wait)
    state.timer.unref?.()
  }

  deliver (kind, text) {
    try {
      this.broadcast({ t: 'alert', s: this.sessionId, kind, text })
    } catch (err) {
      this.logger?.warn?.(`alert broadcast failed: ${err.message}`)
    }
    try {
      this.termux?.notify?.({
        id: `golemlink-${this.sessionId}-${kind}`,
        title: `golemlink: ${this.sessionId}`,
        content: text
      })
    } catch (err) {
      this.logger?.warn?.(`termux notification failed: ${err.message}`)
    }
  }

  destroy () {
    for (const state of this.limits.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    this.limits.clear()
  }
}
