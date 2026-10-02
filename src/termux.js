import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

// Thin wrapper around Termux:API helpers. Everything is a no-op when the
// binary is missing, so the daemon runs unchanged on plain Linux.
export function createTermux ({ logger, notifications = true, wakeLock: wakeLockEnabled = true } = {}) {
  const binaries = {
    notify: findBinary('termux-notification'),
    wakeLock: findBinary('termux-wake-lock'),
    wakeUnlock: findBinary('termux-wake-unlock'),
    openUrl: findBinary('termux-open-url')
  }
  const failed = new Set()

  function run (name, args) {
    const binary = binaries[name]
    if (!binary) return
    execFile(binary, args, { timeout: 5000 }, (err) => {
      if (err && !failed.has(name)) {
        failed.add(name)
        logger?.warn?.(`${name} failed once (further failures suppressed): ${err.message}`)
      }
    })
  }

  return {
    available: {
      notifications: Boolean(binaries.notify) && notifications,
      wakeLock: Boolean(binaries.wakeLock) && wakeLockEnabled,
      openUrl: Boolean(binaries.openUrl)
    },
    notify ({ id, title, content }) {
      if (!binaries.notify || !notifications) return
      const args = ['--title', String(title ?? 'golemlink'), '--content', String(content ?? '')]
      if (id) args.push('--id', String(id))
      run('notify', args)
    },
    wakeLock () {
      if (!binaries.wakeLock || !wakeLockEnabled) return
      run('wakeLock', [])
    },
    wakeUnlock () {
      if (!binaries.wakeUnlock || !wakeLockEnabled) return
      run('wakeUnlock', [])
    },
    openUrl (url) {
      if (!binaries.openUrl) return false
      run('openUrl', [String(url)])
      return true
    }
  }
}

function findBinary (name) {
  const dirs = (process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of dirs) {
    try {
      const candidate = path.join(dir, name)
      const stat = fs.statSync(candidate)
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate
    } catch {}
  }
  return null
}
