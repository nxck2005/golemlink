import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Session } from '../src/session.js'

const require = createRequire(import.meta.url)
export const fromMineflayer = createRequire(require.resolve('mineflayer'))

export function testRegistry (version = '1.21.11') {
  return fromMineflayer('prismarine-registry')(version)
}

export function stubHub () {
  const sent = []
  return {
    sent,
    sendToSubscribers (sid, msg) {
      sent.push({ sid, msg })
    },
    broadcast (msg) {
      sent.push({ broadcast: true, msg })
    },
    subscriberCount () {
      return 1
    },
    states () {
      return sent.map(entry => entry.msg).filter(msg => msg && msg.t === 'state')
    }
  }
}

export function stubManager () {
  return {
    acquireAuth: async () => () => {},
    notifySessionsChanged () {}
  }
}

export function stubLogger () {
  const lines = []
  return {
    lines,
    info: (...args) => lines.push(['info', ...args]),
    warn: (...args) => lines.push(['warn', ...args]),
    error: (...args) => lines.push(['error', ...args]),
    debug: (...args) => lines.push(['debug', ...args])
  }
}

export function stubTermux () {
  return {
    available: { notifications: false, wakeLock: false, notificationsAvailable: false, openUrl: false },
    notify () {},
    wakeLock () {},
    wakeUnlock () {},
    openUrl () {
      return false
    }
  }
}

export function makeSession ({ account, server, hub, manager, noSpawnMs, dataDir, config } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-test-'))
  return new Session({
    account: account || { id: 'acct', auth: 'offline', username: 'TestBot' },
    server: server || { id: 'srv', name: 'srv', host: '127.0.0.1', port: 25565, autoReconnect: false, chatLog: false },
    config: config || { deadmanMs: 600, minimap: { radiusChunks: 6 } },
    dataDir: dir,
    logger: stubLogger(),
    termux: stubTermux(),
    hub: hub || stubHub(),
    manager: manager || stubManager(),
    noSpawnMs
  })
}

export async function waitUntil (predicate, { timeout = 5000, interval = 25, label = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error(`timed out waiting for ${label}`)
}

export function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}
