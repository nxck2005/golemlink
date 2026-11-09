import { performance } from 'node:perf_hooks'

// Vanilla clients since 1.21.2 end every client tick with a tick_end packet.
// Mineflayer never sends it, and some servers treat a client without it as a
// bot: Ultranetwork's Prisons moves such a client back to the lobby within a
// few seconds, with no message.
const TICK_MS = 50
// Mineflayer's physics loop runs at most this many catch-up ticks per timer
// fire, keeping the rest for later. Doing the same keeps one tick_end per
// physics tick when the event loop falls behind.
const MAX_CATCHUP = 4

export function sendsTickEnd (bot) {
  try {
    return bot.supportFeature('sendsClientTickEndPacket') === true
  } catch {
    return false
  }
}

export class TickEnd {
  constructor ({ bot, onError, now = () => performance.now() }) {
    this.bot = bot
    this.onError = onError || (() => {})
    this.now = now
    this.timer = null
    this.last = 0
    this.owed = 0
  }

  // Started on the bot's first 'login', after mineflayer has started its own
  // 50 ms physics timer, so each tick_end follows that tick's movement packet.
  start () {
    if (this.timer || !sendsTickEnd(this.bot)) return false
    this.last = this.now()
    this.owed = 0
    this.timer = setInterval(() => {
      // A throw here would escape the timer and take the daemon down.
      try {
        this.tick()
      } catch (err) {
        this.stop()
        this.onError(err)
      }
    }, TICK_MS)
    this.timer.unref?.()
    return true
  }

  tick () {
    const now = this.now()
    const client = this.bot._client
    this.owed += now - this.last
    this.last = now
    // During a proxy's server switch the client is back in the configuration
    // state, where play packets are not allowed. Drop that time entirely, or
    // play would resume with a burst of stale ticks.
    if (!client || client.state !== 'play') {
      this.owed = 0
      return 0
    }
    let ticks = 0
    while (this.owed >= TICK_MS && ticks < MAX_CATCHUP) {
      this.owed -= TICK_MS
      ticks++
    }
    for (let i = 0; i < ticks; i++) client.write('tick_end', {})
    return ticks
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
