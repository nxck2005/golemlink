import pf from 'mineflayer-pathfinder'

const { Movements, goals } = pf
const { GoalNear } = goals

export const MOMENTARY = ['forward', 'back', 'left', 'right', 'jump']
export const LATCHED = ['sprint', 'sneak']

// True when mineflayer-pathfinder is loaded and can build Movements for this
// bot version. The session falls back to features.goto = false otherwise.
export function pathfinderAvailable (bot) {
  if (!bot?.pathfinder) return false
  try {
    // eslint-disable-next-line no-new
    new Movements(bot)
    return true
  } catch {
    return false
  }
}

export class Movement {
  constructor ({ bot, deadmanMs = 600, logger, onCtlReset, onGoto, sendStatusNow, gotoAvailable = true }) {
    this.bot = bot
    this.deadmanMs = deadmanMs
    this.logger = logger
    this.onCtlReset = onCtlReset || (() => {})
    this.onGoto = onGoto || (() => {})
    this.sendStatusNow = sendStatusNow || (() => {})
    this.gotoAvailable = gotoAvailable
    this.owner = null
    this.lastHold = 0
    this.nextCheck = 0
    this.controls = Object.fromEntries([...MOMENTARY, ...LATCHED].map(k => [k, false]))
    this.checkTimer = setInterval(() => this.checkLease(), 100)
    this.checkTimer.unref?.()
    this.lookTimer = null
    this.pendingLook = null
    this.lastLookAt = 0
    this.gotoState = null // { id, cancelled }
    this.gotoId = 0
    this.savedLatched = null
    this.antiAfkTimer = null
    this.movements = null
  }

  destroy () {
    clearInterval(this.checkTimer)
    if (this.lookTimer) clearTimeout(this.lookTimer)
    if (this.antiAfkTimer) clearTimeout(this.antiAfkTimer)
    try {
      this.bot.clearControlStates()
    } catch {}
    this.cancelGoto('destroy')
  }

  // --- controls ---------------------------------------------------------
  setControl (k, on, clientId) {
    if (!this.controls.hasOwnProperty(k)) return
    if (this.bot == null) return
    if (on && MOMENTARY.includes(k)) {
      this.owner = clientId
      this.lastHold = Date.now()
      if (this.gotoState) this.cancelGoto('control')
    }
    if (this.controls[k] === on) {
      return
    }
    this.controls[k] = on
    try {
      this.bot.setControlState(k, on)
    } catch (err) {
      this.logger?.warn?.(`setControlState(${k}) failed: ${err.message}`)
    }
  }

  hold (clientId) {
    if (this.owner === clientId) this.lastHold = Date.now()
  }

  clearMomentary (reason) {
    let changed = false
    for (const k of MOMENTARY) {
      if (this.controls[k]) {
        changed = true
        this.setControl(k, false, this.owner)
      }
    }
    this.owner = null
    if (changed) this.onCtlReset(reason)
    return changed
  }

  clearAll (reason) {
    const changed = this.clearMomentary(reason)
    for (const k of LATCHED) {
      if (this.controls[k]) {
        // setControl skips unchanged values, so force off
        this.controls[k] = false
        try {
          this.bot.setControlState(k, false)
        } catch {}
      }
    }
    return changed
  }

  releaseLease (clientId) {
    if (this.owner === clientId) this.clearMomentary('disconnect')
  }

  checkLease () {
    const now = Date.now()
    if (this.nextCheck === 0) this.nextCheck = now + 100
    const late = now - this.nextCheck
    this.nextCheck = now + 100
    if (late > 200) return // skipped: let queued heartbeats run first
    if (this.owner && now - this.lastHold > this.deadmanMs) {
      this.clearMomentary('deadman')
    }
  }

  // --- look -------------------------------------------------------------
  look (yaw, pitch) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
    const clamped = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
    this.pendingLook = { yaw, pitch: clamped }
    const now = Date.now()
    const wait = Math.max(0, 50 - (now - this.lastLookAt))
    if (wait === 0) {
      this.applyLook()
    } else if (!this.lookTimer) {
      this.lookTimer = setTimeout(() => {
        this.lookTimer = null
        this.applyLook()
      }, wait)
    }
  }

  applyLook () {
    const pending = this.pendingLook
    if (!pending || !this.bot) return
    this.pendingLook = null
    this.lastLookAt = Date.now()
    this.bot.look(pending.yaw, pending.pitch).catch(() => {})
  }

  lookAt (x, y, z) {
    if (!this.bot) return
    const p = this.bot.entity.position
    // build a Vec3 without importing vec3 directly
    this.bot.lookAt(p.offset(x - p.x, y - p.y, z - p.z)).catch(() => {})
  }

  // --- goto / step ------------------------------------------------------
  ensureMovements () {
    if (this.movements) return this.movements
    const movements = new Movements(this.bot)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.allowParkour = false
    movements.scafoldingBlocks = [] // the library's spelling
    this.bot.pathfinder.setMovements(movements)
    this.bot.pathfinder.tickTimeout = 10
    this.bot.pathfinder.thinkTimeout = 10000
    this.movements = movements
    return movements
  }

  // Synchronous entry point: validates, emits started, and runs in the
  // background. Failures surface through onGoto('failed').
  startGoto (x, z, y) {
    if (!this.gotoAvailable || !this.bot?.pathfinder) {
      throw Object.assign(new Error('pathfinding is not available on this server version'), { code: 'goto_unavailable' })
    }
    const bot = this.bot
    const dx = x - bot.entity.position.x
    const dz = z - bot.entity.position.z
    if (Math.sqrt(dx * dx + dz * dz) > 256) {
      throw Object.assign(new Error('target is more than 256 blocks away'), { code: 'goto_range' })
    }
    this.runGoto(x, z, y).catch(err => {
      if (!this.gotoState) return
      this.gotoState = null
      this.restoreLatched()
      this.onGoto({ phase: 'failed', detail: err?.message || String(err) })
    })
  }

  async runGoto (x, z, y) {
    this.cancelGoto('replaced')
    const id = ++this.gotoId
    const state = { id, cancelled: false }
    this.gotoState = state
    this.ensureMovements()
    this.savedLatched = { sprint: this.controls.sprint, sneak: this.controls.sneak }
    for (const k of LATCHED) {
      if (this.controls[k]) this.setControl(k, false, null)
    }
    const targetY = Number.isFinite(y) ? y : Math.floor(this.bot.entity.position.y)
    const goal = new GoalNear(x, targetY, z, 1)
    this.onGoto({ phase: 'started', x, z, y: targetY })
    try {
      await this.bot.pathfinder.goto(goal)
      if (state.cancelled) return
      this.onGoto({ phase: 'arrived' })
    } catch (err) {
      if (state.cancelled) return
      this.onGoto({ phase: 'failed', detail: err?.message || String(err) })
    } finally {
      if (this.gotoState === state) {
        this.gotoState = null
        this.restoreLatched()
      }
    }
  }

  restoreLatched () {
    const saved = this.savedLatched
    this.savedLatched = null
    if (!saved || !this.bot) return
    for (const k of LATCHED) {
      if (saved[k]) {
        this.controls[k] = true
        try {
          this.bot.setControlState(k, true)
        } catch {}
      }
    }
  }

  cancelGoto (reason) {
    const state = this.gotoState
    if (!state) return false
    state.cancelled = true
    this.gotoState = null
    try {
      this.bot.pathfinder.setGoal(null)
      this.bot.pathfinder.stop()
    } catch {}
    try {
      this.bot.clearControlStates()
    } catch {}
    // clearControlStates wiped everything and pathfinder's fullStop does the
    // same; re-apply latched toggles, then let the caller stop if needed.
    this.restoreLatched()
    this.onGoto({ phase: 'cancelled', detail: reason })
    return true
  }

  stopAll () {
    const cancelled = this.cancelGoto('stop')
    const cleared = this.clearMomentary('stop')
    for (const k of LATCHED) {
      if (this.controls[k]) {
        this.controls[k] = false
        try {
          this.bot.setControlState(k, false)
        } catch {}
      }
    }
    return cancelled || cleared
  }

  step (dir, n) {
    if (!this.bot) throw Object.assign(new Error('session is not online'), { code: 'not_online' })
    const p = this.bot.entity.position
    const offsets = { n: [0, -n], s: [0, n], e: [n, 0], w: [-n, 0] }
    const [dx, dz] = offsets[dir]
    this.startGoto(p.x + dx, p.z + dz)
  }

  ctlState () {
    return { ...this.controls }
  }

  // --- anti-AFK ---------------------------------------------------------
  setAntiAfk (enabled, intervalSec) {
    if (this.antiAfkTimer) {
      clearTimeout(this.antiAfkTimer)
      this.antiAfkTimer = null
    }
    if (!enabled) return
    const schedule = () => {
      const base = intervalSec * 1000
      const jitter = 0.75 + Math.random() * 0.5
      this.antiAfkTimer = setTimeout(() => {
        this.antiAfkTimer = null
        this.antiAfkTick()
        schedule()
      }, Math.max(1000, Math.round(base * jitter)))
    }
    schedule()
  }

  antiAfkTick () {
    if (!this.bot) return
    if (this.owner || this.gotoState) return
    try {
      const yaw = (this.bot.entity.yaw + (Math.random() - 0.5) * 0.6)
      this.bot.look(yaw, 0).catch(() => {})
      this.bot.setControlState('jump', true)
      setTimeout(() => {
        try {
          this.bot.setControlState('jump', false)
        } catch {}
      }, 150).unref?.()
    } catch (err) {
      this.logger?.warn?.(`anti-AFK tick failed: ${err.message}`)
    }
  }
}
