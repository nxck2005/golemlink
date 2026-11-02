import net from 'node:net'

function hostWithPort (name, port) {
  const host = net.isIPv6(name) ? `[${name}]` : name
  return `${host}:${port}`
}

// Which Host headers and Origins the daemon answers to. Anything else is a
// DNS-rebinding attempt or a misconfigured proxy, and is refused.
export function buildAccess ({ port, binds = [], names = [], extraHosts = [] }) {
  const hosts = new Set()
  for (const name of ['127.0.0.1', 'localhost', ...binds, ...names]) {
    if (name) hosts.add(hostWithPort(String(name).toLowerCase(), port))
  }
  for (const entry of extraHosts) {
    const value = String(entry).toLowerCase()
    hosts.add(value)
    if (!/:\d+$/.test(value)) hosts.add(hostWithPort(value, port))
  }
  const origins = new Set()
  for (const host of hosts) {
    origins.add(`http://${host}`)
    origins.add(`https://${host}`)
    // Browsers drop default ports from Origin.
    if (host.endsWith(':443')) origins.add(`https://${host.slice(0, -4)}`)
    if (host.endsWith(':80')) origins.add(`http://${host.slice(0, -3)}`)
  }
  return {
    port,
    hosts,
    origins,
    hostAllowed: host => typeof host === 'string' && hosts.has(host.toLowerCase()),
    originAllowed: origin => typeof origin === 'string' && origins.has(origin.toLowerCase()),
    connectSources: () => [...hosts].flatMap(host => [`ws://${host}`, `wss://${host}`])
  }
}
