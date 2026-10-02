import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const KEEP = 2

function formatArg (arg) {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

// File logger for daemon.log. Never called with secrets: callers redact first.
export function createLogger (dataDir, { console = true } = {}) {
  const file = path.join(dataDir, 'daemon.log')

  function rotateIfNeeded () {
    try {
      const size = fs.statSync(file).size
      if (size < MAX_LOG_BYTES) return
      for (let i = KEEP - 1; i >= 1; i--) {
        const from = `${file}.${i}`
        const to = `${file}.${i + 1}`
        try {
          if (fs.existsSync(from)) fs.renameSync(from, to)
        } catch {}
      }
      try {
        fs.renameSync(file, `${file}.1`)
      } catch {}
    } catch {}
  }

  function write (level, args) {
    const line = `${new Date().toISOString()} ${level} ${args.map(formatArg).join(' ')}\n`
    if (console) {
      const out = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout
      try {
        out.write(line)
      } catch {}
    }
    try {
      rotateIfNeeded()
      fs.appendFileSync(file, line, { mode: 0o600 })
    } catch {}
  }

  return {
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    debug: (...args) => write('DEBUG', args),
    file
  }
}
