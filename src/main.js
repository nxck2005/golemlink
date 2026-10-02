#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createLogger } from './log.js'
import {
  resolveDataDir, ensureDataDir, loadConfig, saveConfig, configPath,
  validateServer, applyServerUpdate, sanitizeAccount, sanitizeServer, validateAccount
} from './config.js'
import { createHttpServer } from './http.js'
import { WsHub } from './ws.js'
import { Sessions } from './sessions.js'
import { createTermux } from './termux.js'
import { supportedRange } from './session.js'

const require = createRequire(import.meta.url)
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
const mineflayerPkg = require('mineflayer/package.json')
const pathfinderPkg = require('mineflayer-pathfinder/package.json')

function parseArgs (argv) {
  const args = { port: null, dataDir: null, open: false, printUrl: false, unsafeBind: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [key, inline] = arg.split('=')
    const next = () => inline !== undefined ? inline : argv[++i]
    switch (key) {
      case '--port': args.port = Number(next()); break
      case '--data-dir': args.dataDir = next(); break
      case '--open': args.open = true; break
      case '--print-url': args.printUrl = true; break
      case '--unsafe-bind': args.unsafeBind = next(); break
      case '--help':
      case '-h': args.help = true; break
      default:
        if (key.startsWith('-')) {
          throw new Error(`unknown option ${key}`)
        }
    }
  }
  if (args.port !== null && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)) {
    throw new Error('--port must be an integer between 1 and 65535')
  }
  if (args.unsafeBind !== null) {
    if (args.unsafeBind === '0.0.0.0' || args.unsafeBind === '::' || args.unsafeBind.trim() === '') {
      throw new Error('--unsafe-bind needs one specific interface address, not 0.0.0.0 or ::')
    }
  }
  return args
}

function checkExistingPid (file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8').trim()
  } catch {
    return
  }
  const pid = Number(raw)
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
  let alive = false
  try {
    process.kill(pid, 0)
    alive = true
  } catch (err) {
    alive = err.code === 'EPERM'
  }
  if (!alive) return
  let cmd = ''
  try {
    cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {}
  if (cmd.includes('golemlink') || cmd.includes('src/main.js')) {
    throw new Error(`refusing to start: daemon.pid names running golemlink process ${pid}`)
  }
}

function usage () {
  return [
    'Usage: node src/main.js [options]',
    '  --port <port>          HTTP/WebSocket port (default from config, 8765)',
    '  --data-dir <dir>       data directory (default ~/.golemlink)',
    '  --open                 open the tokened URL on this device (Termux)',
    '  --print-url            print the tokened URL and exit',
    '  --unsafe-bind <ip>     bind one non-loopback interface address (dangerous)',
    '  -h, --help             show this help'
  ].join('\n')
}

async function main () {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    console.error(usage())
    process.exit(2)
  }
  if (args.help) {
    console.log(usage())
    return
  }

  let dataDir
  try {
    dataDir = resolveDataDir(args.dataDir)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  for (const signal of ['SIGHUP']) {
    process.on(signal, () => {})
  }
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', err => {
      if (err.code === 'EPIPE' || err.code === 'EIO') return
      // nothing useful to do without a terminal
    })
  }

  const { token } = ensureDataDir(dataDir)
  const { config, errors, created } = loadConfig(dataDir)
  if (errors.length > 0) {
    console.error(`invalid config at ${configPath(dataDir)}:`)
    for (const error of errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  if (args.port !== null) config.http.port = args.port
  if (created) saveConfig(dataDir, config)

  const port = args.port !== null ? args.port : (config.http.port || 8765)
  const bindHost = args.unsafeBind || '127.0.0.1'
  const printHost = args.unsafeBind || '127.0.0.1'
  const url = `http://${printHost}:${port}/#t=${token}`

  if (args.printUrl) {
    console.log(url)
    return
  }

  const pidFile = path.join(dataDir, 'daemon.pid')
  try {
    checkExistingPid(pidFile)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })

  const logger = createLogger(dataDir)
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  let loopLagP99 = 0
  const lagTimer = setInterval(() => {
    const raw = histogram.percentile(99) / 1e6
    loopLagP99 = Number.isFinite(raw) ? Math.round(raw * 10) / 10 : 0
    if (loopLagP99 > 50) logger.warn(`event-loop delay p99 ${loopLagP99} ms over 10 s (budget 20 ms)`)
  }, 10000)
  lagTimer.unref?.()

  const rssTimer = setInterval(() => {
    logger.info(`rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`)
  }, 5 * 60 * 1000)
  rssTimer.unref?.()

  const termux = createTermux({
    logger,
    notifications: config.termux.notifications !== false,
    wakeLock: config.termux.wakeLock !== false
  })

  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
  const httpServer = http.createServer(createHttpServer({ webDir, port, unsafeBind: args.unsafeBind, logger }))

  let sessions
  const hub = new WsHub({
    server: httpServer,
    host: bindHost,
    port,
    unsafeBind: args.unsafeBind,
    token,
    sessions: null,
    logger,
    control: {},
    termux
  })

  const getConfig = () => config
  sessions = new Sessions({ getConfig, dataDir, logger, termux, hub })
  hub.sessions = sessions

  Object.assign(hub.control, {
    accountsForUi: () => config.accounts.map(sanitizeAccount),
    serversForUi: () => config.servers.map(sanitizeServer),
    daemonInfo: () => ({
      name: 'golemlink',
      app: pkg.version,
      node: process.versions.node,
      mineflayer: mineflayerPkg.version,
      pathfinder: pathfinderPkg.version,
      loopLagP99,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      supportedRange: supportedRange()
    }),
    startSession: (account, server) => sessions.start(account, server),
    stopSession: id => sessions.stop(id),
    putServer (server) {
      const index = config.servers.findIndex(s => s.id === server.id)
      const merged = applyServerUpdate(index >= 0 ? config.servers[index] : null, server)
      const validationErrors = []
      const { value } = validateServer(merged, { errors: validationErrors })
      if (validationErrors.length > 0) {
        throw Object.assign(new Error(validationErrors.join('; ')), { code: 'bad_config' })
      }
      if (index >= 0) config.servers[index] = value
      else config.servers.push(value)
      saveConfig(dataDir, config)
      sessions.reconcile()
      return value
    },
    delServer (id) {
      const index = config.servers.findIndex(s => s.id === id)
      if (index < 0) throw Object.assign(new Error(`unknown server "${id}"`), { code: 'no_server' })
      config.servers.splice(index, 1)
      config.autostart = config.autostart.filter(entry => !entry.endsWith(`@${id}`))
      saveConfig(dataDir, config)
      sessions.reconcile()
    },
    putAccount (account) {
      const index = config.accounts.findIndex(a => a.id === account.id)
      const merged = index >= 0 ? { ...config.accounts[index], ...account, id: account.id } : account
      const validationErrors = []
      const { value } = validateAccount(merged, { errors: validationErrors })
      if (validationErrors.length > 0) {
        throw Object.assign(new Error(validationErrors.join('; ')), { code: 'bad_config' })
      }
      if (index >= 0) config.accounts[index] = value
      else config.accounts.push(value)
      saveConfig(dataDir, config)
      sessions.reconcile()
      return value
    },
    delAccount (id) {
      const index = config.accounts.findIndex(a => a.id === id)
      if (index < 0) throw Object.assign(new Error(`unknown account "${id}"`), { code: 'no_account' })
      config.accounts.splice(index, 1)
      config.autostart = config.autostart.filter(entry => !entry.startsWith(`${id}@`))
      saveConfig(dataDir, config)
      sessions.reconcile()
    }
  })

  hub.attach()

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, bindHost, () => resolve())
  }).catch(err => {
    logger.error(`cannot listen on ${bindHost}:${port}: ${err.message}`)
    try { fs.unlinkSync(pidFile) } catch {}
    process.exit(1)
  })

  logger.info(`golemlink ${pkg.version} listening on ${bindHost}:${port}`)
  logger.info(`supported Minecraft versions: ${supportedRange()}`)
  if (args.unsafeBind) {
    logger.warn(`UNSAFE BIND: the web UI is reachable from ${args.unsafeBind}. Anyone who can reach the port and read the token has full control of the bots. Prefer an SSH tunnel.`)
  }
  // Printed to stdout only: never through the logger, so the token never
  // lands in daemon.log.
  console.log(`golemlink: open ${url}`)

  if (args.unsafeBind) {
    console.warn('WARNING: --unsafe-bind exposes the daemon beyond localhost. Prefer: ssh -L ' + port + ':127.0.0.1:' + port + ' <phone>')
  }
  if (args.open) {
    if (!termux.openUrl(url)) logger.warn('--open: termux-open-url is not available on this system')
  }

  if (termux.available.wakeLock) termux.wakeLock()

  sessions.startAutostart()

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('shutting down')
    try {
      sessions.stopAll()
    } catch {}
    setTimeout(() => {
      try {
        sessions.destroyAll()
      } catch {}
      hub.destroy()
      httpServer.close()
      try { termux.wakeUnlock() } catch {}
      try { fs.unlinkSync(pidFile) } catch {}
      process.exit(0)
    }, 300)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  process.on('uncaughtException', err => {
    logger.error(`uncaught exception: ${err?.stack || err}`)
    try {
      sessions.destroyAll()
    } catch {}
    try { fs.unlinkSync(pidFile) } catch {}
    process.exit(1)
  })
  process.on('unhandledRejection', reason => {
    logger.error(`unhandled rejection: ${reason?.stack || reason}`)
  })
}

main().catch(err => {
  console.error(err?.stack || err)
  process.exit(1)
})
