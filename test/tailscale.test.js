import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTailscaleIPv4, tailscaleAddressFromInterfaces, parseTailscaleStatus, detectTailscale } from '../src/tailscale.js'
import { buildAccess } from '../src/access.js'

test('only the 100.64.0.0/10 range counts as Tailscale', () => {
  for (const ip of ['100.64.0.1', '100.67.54.111', '100.127.255.254']) assert.equal(isTailscaleIPv4(ip), true, ip)
  for (const ip of ['100.63.0.1', '100.128.0.1', '10.0.0.1', '192.168.1.5', 'fd7a::1', 'nope']) assert.equal(isTailscaleIPv4(ip), false, ip)
})

test('the tailscale interface wins over other CGNAT addresses', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '100.100.1.1', family: 'IPv4', internal: false }],
    tailscale0: [{ address: 'fd7a:115c::1', family: 'IPv6', internal: false }, { address: '100.67.54.111', family: 'IPv4', internal: false }]
  }
  assert.equal(tailscaleAddressFromInterfaces(interfaces), '100.67.54.111')
  assert.equal(tailscaleAddressFromInterfaces({ eth0: [{ address: '192.168.1.5', family: 4, internal: false }] }), null)
})

test('status JSON yields MagicDNS names and the address', () => {
  const status = parseTailscaleStatus(JSON.stringify({ Self: { DNSName: 'Confessor.tail1234.ts.net.', HostName: 'confessor', TailscaleIPs: ['100.67.54.111', 'fd7a::1'] } }))
  assert.deepEqual(status, { address: '100.67.54.111', names: ['confessor.tail1234.ts.net', 'confessor'] })
  assert.equal(parseTailscaleStatus('not json'), null)
  assert.equal(parseTailscaleStatus('{}'), null)
})

test('detection works without the CLI and ignores status addresses no interface has', async () => {
  const interfaces = { tailscale0: [{ address: '100.67.54.111', family: 'IPv4', internal: false }] }
  assert.deepEqual(await detectTailscale({ interfaces, exec: async () => null }), { address: '100.67.54.111', names: [] })
  const status = JSON.stringify({ Self: { TailscaleIPs: ['100.70.0.1'] } })
  const none = await detectTailscale({ interfaces: { eth0: [] }, exec: async () => status })
  assert.equal(none.address, null)
})

test('access allows loopback, binds, tailnet names and extra hosts only', () => {
  const access = buildAccess({ port: 6767, binds: ['100.67.54.111'], names: ['confessor.tail1234.ts.net', 'confessor'], extraHosts: ['proxy.example.ts.net'] })
  for (const host of ['127.0.0.1:6767', 'localhost:6767', '100.67.54.111:6767', 'confessor:6767', 'Confessor.tail1234.ts.net:6767', 'proxy.example.ts.net', 'proxy.example.ts.net:6767']) {
    assert.equal(access.hostAllowed(host), true, host)
  }
  for (const host of ['evil.example:6767', '100.67.54.111:80', 'confessor', undefined]) assert.equal(access.hostAllowed(host), false, String(host))
  assert.equal(access.originAllowed('http://confessor:6767'), true)
  assert.equal(access.originAllowed('https://proxy.example.ts.net'), true)
  assert.equal(access.originAllowed('http://evil.example'), false)
  assert.equal(access.originAllowed(undefined), false)
  assert.ok(access.connectSources().includes('ws://100.67.54.111:6767'))
})
