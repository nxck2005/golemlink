#!/usr/bin/env node
// In-process fake Minecraft server for e2e tier 1 and integration tests.
//
// Uses the same protocol stack as the installed mineflayer (minecraft-protocol,
// prismarine-registry, prismarine-chunk, prismarine-item, vec3 loaded through
// createRequire(require.resolve('mineflayer'))), so no extra dependency is added.
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const fromMineflayer = createRequire(require.resolve('mineflayer'))
const mc = fromMineflayer('minecraft-protocol')
const Registry = fromMineflayer('prismarine-registry')
const ChunkLoader = fromMineflayer('prismarine-chunk')
const { Vec3 } = fromMineflayer('vec3')
const ItemLoader = fromMineflayer('prismarine-item')
const nbt = fromMineflayer('prismarine-nbt')

const DEFAULT_VERSION = process.env.MC_VERSION || '1.21.11'

export class FakeServer extends EventEmitter {
  constructor ({ version = DEFAULT_VERSION, port = 0, host = '127.0.0.1', motd = 'golemlink fake server', pingVersion = null, sendHealth = true, spawn = { x: 8.5, y: 65, z: 8.5, yaw: 0, pitch: 0 } } = {}) {
    super()
    this.version = version
    this.port = port
    this.host = host
    this.motd = motd
    this.pingVersion = pingVersion
    this.sendHealth = sendHealth
    this.spawn = spawn
    this.registry = Registry(version)
    this.Chunk = ChunkLoader(this.registry)
    this.Item = ItemLoader(this.registry)
    this.isCaves = this.registry.version['>=']('1.18')
    this.minY = this.isCaves ? -64 : 0
    this.worldHeight = this.isCaves ? 384 : 256
    this.chunks = new Map()
    this.players = new Map() // username -> client
    this.packets = [] // {name, data, at}
    this.chatLog = []
    this.inventorySlots = new Array(46).fill(null)
    this.openWindows = new Map() // windowId -> {slots, type}
    this.nextWindowId = 1
    this.resourcePackResults = []
    this.duplicateKicks = []
    this.closed = false
    this.stateId = 0
  }

  async start () {
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) this.ensureChunk(cx, cz)
    }
    const floorY = Math.floor(this.spawn.y) - 1
    const stone = this.stateIdOf('stone')
    for (const chunk of this.chunks.values()) {
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, floorY, z), stone)
      }
    }
    const options = {
      host: this.host,
      port: this.port,
      version: this.version,
      motd: this.motd,
      'online-mode': false,
      maxPlayers: 20,
      hideErrors: true
    }
    if (this.pingVersion) {
      options.beforePing = response => {
        response.version = { name: this.pingVersion.name, protocol: this.pingVersion.protocol }
      }
    }
    this.server = mc.createServer(options)
    this.server.on('error', err => this.emit('error', err))
    this.server.on('playerJoin', client => this.onPlayerJoin(client))
    await new Promise((resolve, reject) => {
      this.server.once('listening', resolve)
      this.server.once('error', reject)
    })
    this.port = this.server.socketServer.address().port
    return this.port
  }

  async stop () {
    this.closed = true
    for (const client of this.players.values()) {
      try {
        client._end('closed')
      } catch {}
    }
    this.players.clear()
    if (!this.server) return
    await new Promise(resolve => {
      try {
        this.server.close()
      } catch {}
      resolve()
    })
  }

  // --- world ------------------------------------------------------------
  ensureChunk (cx, cz) {
    const key = `${cx},${cz}`
    let chunk = this.chunks.get(key)
    if (!chunk) {
      chunk = new this.Chunk({ minY: this.minY, worldHeight: this.worldHeight })
      this.chunks.set(key, chunk)
    }
    return chunk
  }

  stateIdOf (name) {
    const block = this.registry.blocksByName[name]
    if (!block) throw new Error(`unknown block ${name}`)
    return block.defaultState ?? block.minStateId
  }

  setBlockGlobal (name, x, y, z) {
    const cx = Math.floor(x / 16)
    const cz = Math.floor(z / 16)
    const chunk = this.ensureChunk(cx, cz)
    chunk.setBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16), this.stateIdOf(name))
  }

  placeBlock (name, x, y, z) {
    this.setBlockGlobal(name, x, y, z)
    if (this.client) {
      this.client.write('block_change', { location: { x, y, z }, type: this.stateIdOf(name) })
    }
  }

  // Flat 3-high wall along x, spanning `width` blocks, at z.
  buildWall ({ x = 6, z = 14, width = 5, height = 3, baseY = null } = {}) {
    const y0 = baseY ?? Math.floor(this.spawn.y)
    for (let i = 0; i < width; i++) {
      for (let h = 0; h < height; h++) {
        this.placeBlock('stone', x + i, y0 + h, z)
      }
    }
  }

  chunkPacket (cx, cz) {
    const chunk = this.ensureChunk(cx, cz)
    return {
      x: cx,
      z: cz,
      heightmaps: [],
      chunkData: chunk.dump(),
      blockEntities: [],
      ...chunk.dumpLight()
    }
  }

  sendChunks (client) {
    for (const key of this.chunks.keys()) {
      const [cx, cz] = key.split(',').map(Number)
      client.write('map_chunk', this.chunkPacket(cx, cz))
    }
  }

  // --- login / connection ----------------------------------------------
  onPlayerJoin (client) {
    const username = client.username
    if (this.players.has(username)) {
      const first = this.players.get(username)
      this.duplicateKicks.push({ username, at: Date.now() })
      const reason = nbt.comp({ translate: nbt.string('multiplayer.disconnect.duplicate_login') })
      this.kickClient(first, reason)
      this.kickClient(client, reason)
      return
    }
    this.players.set(username, client)
    this.client = client
    client.write('login', { ...this.registry.loginPacket, entityId: client.id })
    this.sendChunks(client)
    client.write('position', {
      teleportId: 1,
      x: this.spawn.x,
      y: this.spawn.y,
      z: this.spawn.z,
      dx: 0,
      dy: 0,
      dz: 0,
      yaw: this.spawn.yaw,
      pitch: this.spawn.pitch,
      flags: {}
    })
    if (this.sendHealth) client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
    client.write('update_time', { age: 0n, time: 0n, tickDayTime: true })

    client.on('packet', (data, meta) => {
      const packet = { name: meta.name, data, at: Date.now() }
      this.packets.push(packet)
      this.emit('packet', packet)
      this.handlePacket(client, meta.name, data)
    })
    client.on('end', () => {
      if (this.players.get(username) === client) this.players.delete(username)
      if (this.client === client) this.client = null
      this.emit('playerEnd', username)
    })
    this.emit('playerJoin', client)
    this.emit('join', client)
  }

  handlePacket (client, name, data) {
    if (name === 'chat_message' || name === 'chat_command' || name === 'chat_command_signed') {
      const text = data.message
      this.chatLog.push(text)
      this.emit('chat', text)
      const label = text.startsWith('/') ? text : `<${client.username}> ${text}`
      this.say(label)
    } else if (name === 'block_place' || name === 'use_item_on') {
      // Chest interaction: any right-click opens the tracked chest window.
      if (this.chestAt && (this.chestWindow === null || !this.openWindows.has(this.chestWindow))) {
        this.openChestWindow()
      }
    } else if (name === 'resource_pack_receive') {
      this.resourcePackResults.push(data.result)
    } else if (name === 'window_click') {
      this.applyRecordedClick(data)
      this.emit('windowClick', data)
    } else if (name === 'close_window') {
      this.openWindows.delete(data.windowId)
      this.emit('windowClose', data.windowId)
    } else if (name === 'position' || name === 'position_look') {
      this.lastPosition = { x: data.x, y: data.y, z: data.z, yaw: data.yaw, pitch: data.pitch, at: Date.now() }
    }
  }

  // Keep a rough server-side mirror so the fake server stays self-consistent.
  applyRecordedClick (click) {
    // Intentional no-op: the daemon's local window model already applies
    // mode-0 clicks optimistically and the fake server only needs the record.
  }

  kickClient (client, reason, { close = true } = {}) {
    try {
      client.write('kick_disconnect', { reason })
    } catch {}
    if (close) {
      setTimeout(() => {
        try {
          client._end('kicked')
        } catch {}
      }, 20)
    }
  }

  kickCurrent (reason, options) {
    const clients = [...this.players.values()]
    if (clients.length === 0) throw new Error('no player connected')
    for (const client of clients) this.kickClient(client, reason, options)
  }

  kickUser (username, reason, options) {
    const client = this.players.get(username)
    if (!client) throw new Error(`no player ${username}`)
    this.kickClient(client, reason, options)
  }

  kickUserTranslate (username, translate) {
    this.kickUser(username, nbt.comp({ translate: nbt.string(translate) }))
  }

  // Plain text or a translation key.
  kickText (text) {
    this.kickCurrent(nbt.comp({ text: nbt.string(text) }))
  }

  kickTranslate (translate) {
    this.kickCurrent(nbt.comp({ translate: nbt.string(translate) }))
  }

  // --- scripting --------------------------------------------------------
  say (text) {
    if (!this.client) return
    this.client.write('system_chat', { content: nbt.comp({ text: nbt.string(text) }), isActionBar: false })
  }

  actionBar (text) {
    if (!this.client) return
    this.client.write('system_chat', { content: nbt.comp({ text: nbt.string(text) }), isActionBar: true })
  }

  setHealth (health, food = 20) {
    if (!this.client) return
    this.client.write('update_health', { health, food, foodSaturation: 5 })
  }

  teleport (x, y, z, yaw = 0, pitch = 0) {
    if (!this.client) return
    this.teleportId = (this.teleportId || 1) + 1
    this.client.write('position', {
      teleportId: this.teleportId,
      x,
      y,
      z,
      dx: 0,
      dy: 0,
      dz: 0,
      yaw,
      pitch,
      flags: {}
    })
  }

  sendResourcePack (url = 'http://127.0.0.1:1/pack.zip') {
    if (!this.client) return
    const uuid = '00000000-0000-4000-8000-000000000001'
    this.client.write('add_resource_pack', { uuid, url, hash: '', forced: false })
    return uuid
  }

  itemStack (name, count) {
    const id = this.registry.itemsByName[name].id
    const item = new this.Item(id, count, 0, null)
    return this.Item.toNotch(item)
  }

  emptySlot () {
    return this.Item.toNotch(null)
  }

  // Player inventory window (id 0) update. `slots` is an array of network items.
  sendWindowItems (windowId, slots, carriedItem = undefined) {
    if (!this.client) return
    this.stateId = (this.stateId + 1) & 0x7fff
    const items = slots.map(slot => slot ?? this.emptySlot())
    this.client.write('window_items', {
      windowId,
      stateId: this.stateId,
      items,
      carriedItem: carriedItem === undefined ? this.emptySlot() : carriedItem
    })
  }

  giveItem (slot, name, count) {
    const stack = name === null ? this.emptySlot() : this.itemStack(name, count)
    this.inventorySlots[slot] = stack
    this.sendWindowItems(0, this.inventorySlots)
    return stack
  }

  setInventorySlot (slot, name, count) {
    this.giveItem(slot, name, count)
  }

  // --- chest ------------------------------------------------------------
  trackChest (x, y, z) {
    this.chestAt = { x, y, z }
    this.chestWindow = null
    this.chestSlots = new Array(27).fill(null)
    this.placeBlock('chest', x, y, z)
  }

  openChestWindow () {
    if (!this.client) return
    const windowId = this.nextWindowId++
    this.chestWindow = windowId
    const slots = []
    for (let i = 0; i < 27; i++) slots.push(this.chestSlots[i] ?? this.emptySlot())
    for (let i = 9; i < 45; i++) slots.push(this.inventorySlots[i] ?? this.emptySlot())
    this.openWindows.set(windowId, { slots, type: 3 })
    this.client.write('open_window', {
      windowId,
      inventoryType: 2, // minecraft:generic_9x3 on the wire
      windowTitle: nbt.comp({ text: nbt.string('Chest') })
    })
    this.sendWindowItems(windowId, slots)
    return windowId
  }

  closeChestWindow () {
    if (!this.client || this.chestWindow === null) return
    this.client.write('close_window', { windowId: this.chestWindow })
    this.openWindows.delete(this.chestWindow)
    this.chestWindow = null
  }

  setChestSlot (slot, name, count) {
    this.chestSlots[slot] = name === null ? null : this.itemStack(name, count)
    if (this.chestWindow !== null && this.client) {
      const windowInfo = this.openWindows.get(this.chestWindow)
      windowInfo.slots[slot] = this.chestSlots[slot] ?? this.emptySlot()
      this.stateId = (this.stateId + 1) & 0x7fff
      this.client.write('set_slot', {
        windowId: this.chestWindow,
        stateId: this.stateId,
        slot,
        item: windowInfo.slots[slot]
      })
    }
  }

  // --- introspection ----------------------------------------------------
  position () {
    return this.lastPosition || null
  }

  countPackets (name) {
    return this.packets.filter(p => p.name === name).length
  }

  packetsNamed (name) {
    return this.packets.filter(p => p.name === name)
  }

  waitForPacket (name, predicate = () => true, timeout = 5000) {
    const existing = this.packets.find(p => p.name === name && predicate(p.data))
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('packet', onPacket)
        reject(new Error(`timed out waiting for packet ${name}`))
      }, timeout)
      const onPacket = packet => {
        if (packet.name === name && predicate(packet.data)) {
          clearTimeout(timer)
          this.off('packet', onPacket)
          resolve(packet)
        }
      }
      this.on('packet', onPacket)
    })
  }

  waitForPosition (predicate = () => true, timeout = 5000) {
    const check = () => this.lastPosition && predicate(this.lastPosition)
    if (check()) return Promise.resolve(this.lastPosition)
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (check()) {
          clearInterval(timer)
          resolve(this.lastPosition)
        }
      }, 50)
      setTimeout(() => {
        clearInterval(timer)
        reject(new Error('timed out waiting for position'))
      }, timeout)
    })
  }
}

export async function startFakeServer (options) {
  const server = new FakeServer(options)
  await server.start()
  return server
}

// Raw protocol client (used by e2e to force a duplicate login).
export function createRawClient (options) {
  return mc.createClient(options)
}

export function supportedFakeVersions () {
  return [DEFAULT_VERSION]
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 25566)
  const server = await startFakeServer({ port })
  console.log(`fake server (${server.version}) on 127.0.0.1:${server.port}`)
  server.on('join', client => console.log(`${client.username} joined`))
  server.on('chat', text => console.log(`chat: ${text}`))
  process.on('SIGINT', async () => {
    await server.stop()
    process.exit(0)
  })
}
