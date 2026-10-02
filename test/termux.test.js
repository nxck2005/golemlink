import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTermux } from '../src/termux.js'

test('termux helpers are no-ops when the binaries are missing', () => {
  const originalPath = process.env.PATH
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-path-'))
  process.env.PATH = empty
  try {
    const termux = createTermux({ logger: { warn () {} } })
    assert.equal(termux.available.notifications, false)
    assert.equal(termux.available.wakeLock, false)
    assert.equal(termux.available.openUrl, false)
    assert.doesNotThrow(() => {
      termux.notify({ id: 'x', title: 't', content: 'c' })
      termux.wakeLock()
      termux.wakeUnlock()
      assert.equal(termux.openUrl('http://127.0.0.1/'), false)
    })
  } finally {
    process.env.PATH = originalPath
  }
})

test('termux helpers execFile detected binaries with an args array', async () => {
  const originalPath = process.env.PATH
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-bin-'))
  const logFile = path.join(dir, 'calls.log')
  const script = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(logFile)}\n`
  fs.writeFileSync(path.join(dir, 'termux-notification'), script, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'termux-wake-lock'), script, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'termux-open-url'), script, { mode: 0o755 })
  process.env.PATH = dir
  try {
    const termux = createTermux({ logger: { warn () {} } })
    assert.equal(termux.available.notifications, true)
    termux.notify({ id: 'golemlink-a@s-damage', title: 'golemlink', content: 'hello world' })
    termux.wakeLock()
    termux.openUrl('http://127.0.0.1:8765/#t=x')
    await new Promise(resolve => setTimeout(resolve, 500))
    const text = fs.readFileSync(logFile, 'utf8')
    assert.match(text, /termux-notification/)
    assert.match(text, /--id golemlink-a\/s-damage|--id golemlink-a@s-damage/)
    assert.match(text, /--content hello world/)
    assert.match(text, /termux-wake-lock/)
    assert.match(text, /termux-open-url http:\/\/127\.0\.0\.1:8765/)
  } finally {
    process.env.PATH = originalPath
  }
})

test('notifications and wake lock can be disabled', () => {
  const originalPath = process.env.PATH
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-bin2-'))
  const logFile = path.join(dir, 'calls.log')
  const script = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(logFile)}\n`
  fs.writeFileSync(path.join(dir, 'termux-notification'), script, { mode: 0o755 })
  process.env.PATH = dir
  try {
    const termux = createTermux({ logger: { warn () {} }, notifications: false, wakeLock: false })
    assert.equal(termux.available.notifications, false)
    assert.equal(termux.available.wakeLock, false)
    termux.notify({ id: 'x', title: 't', content: 'c' })
    termux.wakeLock()
    assert.equal(fs.existsSync(logFile), false)
  } finally {
    process.env.PATH = originalPath
  }
})
