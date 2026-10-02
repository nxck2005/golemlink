import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

// Runs a real vanilla server from a downloaded jar. Test-only: the daemon
// itself never spawns long-lived children.
export class VanillaServer {
  constructor (proc, port, dir, outputRef) {
    this.proc = proc
    this.port = port
    this.dir = dir
    this.outputRef = outputRef
  }

  static async start ({ jar, version = '1.21.11', memory = '1G', timeoutMs = 180000 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-vanilla-'))
    const port = await freePort()
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
    fs.writeFileSync(path.join(dir, 'server.properties'), [
      `server-port=${port}`,
      'server-ip=127.0.0.1',
      'online-mode=false',
      'level-type=minecraft:flat',
      'difficulty=peaceful',
      'spawn-protection=0',
      'view-distance=6',
      'simulation-distance=6',
      'motd=golemlink e2e',
      'enable-status=false',
      'sync-chunk-writes=false',
      'max-players=10',
      ''
    ].join('\n'))
    const outputRef = { text: '' }
    const proc = spawn('java', ['-Xms512M', `-Xmx${memory}`, '-jar', jar, 'nogui'], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    proc.stdout.on('data', data => {
      outputRef.text += data.toString()
      if (process.env.E2E_VERBOSE) process.stdout.write(`[vanilla] ${data}`)
    })
    proc.stderr.on('data', data => {
      outputRef.text += data.toString()
      if (process.env.E2E_VERBOSE) process.stderr.write(`[vanilla!] ${data}`)
    })
    const server = new VanillaServer(proc, port, dir, outputRef)
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (/Done \([\d.]+s\)!/.test(outputRef.text)) {
          clearInterval(timer)
          clearTimeout(failTimer)
          resolve()
        }
      }, 500)
      const failTimer = setTimeout(() => {
        clearInterval(timer)
        reject(new Error(`vanilla server did not start in time\n${outputRef.text.slice(-4000)}`))
      }, timeoutMs)
      proc.once('exit', code => {
        clearInterval(timer)
        clearTimeout(failTimer)
        reject(new Error(`vanilla server exited early (${code})\n${outputRef.text.slice(-4000)}`))
      })
    })
    return server
  }

  console (command) {
    return new Promise((resolve, reject) => {
      this.proc.stdin.write(command + '\n', err => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  waitForLog (substring, timeout = 8000) {
    const start = this.outputRef.text.length
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (this.outputRef.text.slice(start).includes(substring)) {
          clearInterval(timer)
          clearTimeout(failTimer)
          resolve(true)
        }
      }, 200)
      const failTimer = setTimeout(() => {
        clearInterval(timer)
        reject(new Error(`timed out waiting for "${substring}" in server log`))
      }, timeout)
    })
  }

  async stop () {
    if (this.proc.exitCode !== null) {
      fs.rmSync(this.dir, { recursive: true, force: true })
      return
    }
    try {
      this.proc.stdin.write('stop\n')
    } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try {
          this.proc.kill('SIGKILL')
        } catch {}
        resolve()
      }, 20000)
      this.proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}
