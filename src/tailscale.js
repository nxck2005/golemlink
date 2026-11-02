import os from 'node:os'
import { execFile } from 'node:child_process'

// Tailscale hands out IPv4 addresses from the CGNAT range 100.64.0.0/10.
export function isTailscaleIPv4 (address) {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

// Returns the Tailscale IPv4 address from the local interfaces, preferring an
// interface named like tailscale0 (Linux) or utun* (macOS).
export function tailscaleAddressFromInterfaces (interfaces = os.networkInterfaces()) {
  const found = []
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const entry of addresses || []) {
      const family = entry.family === 4 ? 'IPv4' : entry.family
      if (family !== 'IPv4' || entry.internal) continue
      if (!isTailscaleIPv4(entry.address)) continue
      found.push({ name, address: entry.address })
    }
  }
  found.sort((a, b) => Number(/^tailscale/.test(b.name)) - Number(/^tailscale/.test(a.name)))
  return found[0]?.address || null
}

function run (file, args, timeout = 3000) {
  return new Promise(resolve => {
    try {
      execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout))
      })
    } catch {
      resolve(null)
    }
  })
}

// Reads `tailscale status --json` for this machine's IPv4 address and its
// MagicDNS names. Returns null when the CLI is missing or not logged in.
export function parseTailscaleStatus (text) {
  let status
  try {
    status = JSON.parse(text)
  } catch {
    return null
  }
  const self = status?.Self
  if (!self) return null
  const names = new Set()
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '').toLowerCase() : ''
  if (dnsName) {
    names.add(dnsName)
    names.add(dnsName.split('.')[0])
  }
  if (typeof self.HostName === 'string' && /^[a-z0-9-]+$/i.test(self.HostName)) names.add(self.HostName.toLowerCase())
  const address = (self.TailscaleIPs || []).find(isTailscaleIPv4) || null
  return { address, names: [...names] }
}

export async function detectTailscale ({ interfaces, exec = run } = {}) {
  const status = parseTailscaleStatus(await exec('tailscale', ['status', '--json']) || '')
  let address = tailscaleAddressFromInterfaces(interfaces)
  if (!address && status?.address) {
    // Userspace networking has no tailscale0 interface; only use the status
    // address when an interface actually carries it.
    const all = Object.values(interfaces || os.networkInterfaces()).flat()
    if (all.some(entry => entry?.address === status.address)) address = status.address
  }
  return { address, names: status?.names || [] }
}
