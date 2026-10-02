import { performance } from 'node:perf_hooks'

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air'])

// Ordered name patterns -> base colour. First match wins.
const PALETTE = [
  [/grass_block|grass$/, [106, 170, 64]],
  [/leaves|_leaves/, [60, 130, 40]],
  [/water|bubble_column/, [48, 92, 190]],
  [/sand$|sandstone|_sand$/, [219, 207, 163]],
  [/red_sand/, [190, 102, 33]],
  [/deepslate/, [80, 80, 86]],
  [/stone|_ore$|cobblestone|andesite|diorite|granite|tuff/, [125, 125, 125]],
  [/dirt|mud|podzol|coarse_dirt|rooted_dirt/, [134, 96, 67]],
  [/snow|ice|powder_snow/, [240, 250, 250]],
  [/lava|magma/, [207, 91, 18]],
  [/netherrack/, [111, 53, 53]],
  [/basalt|blackstone|obsidian|sculk/, [40, 38, 45]],
  [/end_stone|purpur|chorus/, [219, 222, 158]],
  [/terracotta|concrete/, [150, 100, 82]],
  [/log|_wood|planks|bamboo|barrel|chest|crafting_table|bookshelf|sign$/, [140, 106, 64]],
  [/gold|_gold$/, [252, 216, 90]],
  [/diamond/, [80, 230, 220]],
  [/emerald/, [60, 220, 110]],
  [/iron|anvil|cauldron/, [200, 200, 205]],
  [/copper|_copper/, [200, 120, 70]],
  [/coal/, [45, 45, 45]],
  [/redstone/, [200, 40, 40]],
  [/lapis/, [40, 80, 200]],
  [/quartz/, [230, 225, 215]],
  [/wool|_carpet|terracotta/, [190, 190, 190]],
  [/bed$/, [140, 30, 30]],
  [/nether|soul_sand|soul_soil|glowstone|shroomlight/, [120, 60, 60]],
  [/warped|warped_nylium/, [43, 140, 140]],
  [/crimson|crimson_nylium/, [140, 40, 70]],
  [/prismarine|sea_lantern/, [90, 160, 150]],
  [/coral/, [200, 100, 180]],
  [/farmland|wheat|carrots|potatoes|beetroots|melon|pumpkin|hay/, [170, 150, 60]],
  [/cactus/, [80, 140, 60]],
  [/gravel|clay/, [150, 145, 140]],
  [/snow_block/, [250, 250, 250]],
  [/honey|_honey/, [250, 180, 60]],
  [/slime/, [110, 190, 90]],
  [/amethyst/, [150, 100, 220]],
  [/calcite|dripstone/, [220, 215, 205]],
  [/moss/, [90, 130, 50]],
  [/vine|lily|azalea|flower|sapling|fern/, [70, 150, 60]],
  [/mushroom/, [170, 140, 130]],
  [/glass|beacon|lantern|torch/, [230, 230, 200]],
  [/brick/, [150, 80, 70]],
  [/sandstone/, [216, 203, 155]]
]

function hashColor (name) {
  let hash = 2166136261
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const r = 60 + (hash & 0x7f)
  const g = 60 + ((hash >> 7) & 0x7f)
  const b = 60 + ((hash >> 14) & 0x7f)
  return [r, g, b]
}

function shade (rgb, factor) {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * factor)))
  ]
}

// A time-sliced per-chunk tile builder. Tiles are 16x16 RGB buffers, rows
// along z and columns along x (spec §7).
export class Minimap {
  constructor ({ bot, registry, radiusChunks = 6, isWanted = () => true, onTiles = () => {}, onUntile = () => {}, logger, sliceMs = 5 }) {
    this.bot = bot
    this.registry = registry
    this.radiusChunks = radiusChunks
    this.isWanted = isWanted
    this.onTiles = onTiles
    this.onUntile = onUntile
    this.logger = logger
    this.sliceMs = sliceMs
    this.colorCache = new Map() // stateId -> [r,g,b]
    this.topHeights = new Map() // "cx,cz" -> Uint16Array(256), 0 = unknown
    this.tiles = new Map() // "cx,cz" -> tile {cx,cz,rgb}
    this.queue = new Map() // "cx,cz" -> {cx,cz}
    this.debounce = new Map() // "cx,cz" -> timeout
    this.loopScheduled = false
    this.batch = []
    this.rangeTimer = null
    this.destroyed = false
  }

  start () {
    const bot = this.bot
    this.onLoad = corner => this.queueTile(corner.x >> 4, corner.z >> 4)
    this.onUnload = corner => this.dropTile(corner.x >> 4, corner.z >> 4, true)
    this.onBlockUpdate = (oldBlock, newBlock) => {
      if (!newBlock?.position) return
      const cx = Math.floor(newBlock.position.x) >> 4
      const cz = Math.floor(newBlock.position.z) >> 4
      this.debounceTile(cx, cz)
    }
    this.onRespawn = () => this.reset()
    bot.on('chunkColumnLoad', this.onLoad)
    bot.on('chunkColumnUnload', this.onUnload)
    bot.on('blockUpdate', this.onBlockUpdate)
    bot.on('respawn', this.onRespawn)
    this.rangeTimer = setInterval(() => this.pruneRange(), 1000)
    this.rangeTimer.unref?.()
  }

  destroy () {
    this.destroyed = true
    clearInterval(this.rangeTimer)
    for (const timer of this.debounce.values()) clearTimeout(timer)
    this.debounce.clear()
    const bot = this.bot
    bot.removeListener('chunkColumnLoad', this.onLoad)
    bot.removeListener('chunkColumnUnload', this.onUnload)
    bot.removeListener('blockUpdate', this.onBlockUpdate)
    bot.removeListener('respawn', this.onRespawn)
  }

  // Queue every loaded chunk (used when the first UI subscribes, or after a
  // dimension change resets the world).
  refreshAll () {
    const columns = this.bot.world?.getColumns?.() || []
    for (const entry of columns) {
      const cx = Number(entry.chunkX)
      const cz = Number(entry.chunkZ)
      if (Number.isInteger(cx) && Number.isInteger(cz)) this.queueTile(cx, cz)
    }
    // If the world offers no column list, at least rebuild the tiles we know.
    for (const key of this.tiles.keys()) {
      const [cx, cz] = key.split(',').map(Number)
      this.queueTile(cx, cz)
    }
  }

  reset () {
    const out = [...this.tiles.keys()].map(key => {
      const [cx, cz] = key.split(',').map(Number)
      return { cx, cz }
    })
    this.tiles.clear()
    this.topHeights.clear()
    this.queue.clear()
    this.batch = []
    for (const timer of this.debounce.values()) clearTimeout(timer)
    this.debounce.clear()
    if (out.length > 0) this.onUntile(out)
  }

  debounceTile (cx, cz) {
    const key = `${cx},${cz}`
    if (this.debounce.has(key)) return
    const timer = setTimeout(() => {
      this.debounce.delete(key)
      this.queueTile(cx, cz)
    }, 250)
    timer.unref?.()
    this.debounce.set(key, timer)
  }

  queueTile (cx, cz) {
    if (this.destroyed) return
    this.queue.set(`${cx},${cz}`, { cx, cz })
    this.scheduleLoop()
  }

  scheduleLoop () {
    if (this.loopScheduled) return
    this.loopScheduled = true
    setImmediate(() => {
      this.loopScheduled = false
      this.runSlice()
    }).unref?.()
  }

  runSlice () {
    if (this.destroyed) return
    const start = performance.now()
    while (this.queue.size > 0 && performance.now() - start < this.sliceMs) {
      if (!this.isWanted()) {
        this.queue.clear()
        break
      }
      const [key, { cx, cz }] = this.queue.entries().next().value
      this.queue.delete(key)
      const tile = this.buildTile(cx, cz)
      if (tile) {
        this.tiles.set(key, tile)
        this.batch.push(tile)
        if (this.batch.length >= 32) this.flushBatch()
      }
    }
    this.flushBatch()
    if (this.queue.size > 0) this.scheduleLoop()
  }

  flushBatch () {
    if (this.batch.length === 0) return
    const batch = this.batch
    this.batch = []
    this.onTiles(batch)
  }

  allTiles () {
    return [...this.tiles.values()]
  }

  dropTile (cx, cz, notify) {
    const key = `${cx},${cz}`
    const had = this.tiles.delete(key) || this.topHeights.delete(key)
    this.queue.delete(key)
    if (notify && had) this.onUntile([{ cx, cz }])
  }

  pruneRange () {
    const bot = this.bot
    if (!bot?.entity) return
    const bcx = Math.floor(bot.entity.position.x) >> 4
    const bcz = Math.floor(bot.entity.position.z) >> 4
    const out = []
    for (const key of this.tiles.keys()) {
      const [cx, cz] = key.split(',').map(Number)
      if (Math.abs(cx - bcx) > this.radiusChunks || Math.abs(cz - bcz) > this.radiusChunks) {
        out.push({ cx, cz })
      }
    }
    if (out.length > 0) {
      for (const { cx, cz } of out) {
        this.tiles.delete(`${cx},${cz}`)
        this.topHeights.delete(`${cx},${cz}`)
      }
      this.onUntile(out)
    }
  }

  blockNameAt (column, x, y, z) {
    const stateId = column.getBlockStateId({ x, y, z })
    const block = this.registry.blocksByStateId[stateId]
    return { stateId, name: block?.name || 'unknown' }
  }

  colorFor (name, stateId) {
    let color = this.colorCache.get(stateId)
    if (color) return color
    for (const [pattern, rgb] of PALETTE) {
      if (pattern.test(name)) {
        color = rgb
        break
      }
    }
    if (!color) color = hashColor(name)
    this.colorCache.set(stateId, color)
    return color
  }

  dimensionHasCeiling () {
    const dim = this.bot.game?.dimension
    return typeof dim === 'string' && dim.includes('nether')
  }

  buildTile (cx, cz) {
    const bot = this.bot
    const column = bot.world?.getColumn?.(cx, cz)
    if (!column) return null
    const minY = bot.game?.minY ?? -64
    const worldHeight = bot.game?.height ?? 384
    const maxY = minY + worldHeight - 1
    const startY = this.dimensionHasCeiling()
      ? Math.min(Math.floor(bot.entity.position.y) + 2, maxY)
      : Math.min(Math.floor(bot.entity.position.y) + 48, maxY)
    const floor = Math.max(minY, startY - 128)

    const topY = new Int16Array(256).fill(-32768)
    const colors = new Array(256)
    const rgb = Buffer.alloc(16 * 16 * 3)
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        let foundY = null
        let name = null
        let stateId = 0
        for (let y = startY; y >= floor; y--) {
          const result = this.blockNameAt(column, x, y, z)
          if (!AIR_NAMES.has(result.name)) {
            foundY = y
            name = result.name
            stateId = result.stateId
            break
          }
        }
        const index = z * 16 + x
        if (foundY === null) {
          colors[index] = [14, 16, 20]
          continue
        }
        topY[index] = foundY
        let color = this.colorFor(name, stateId)
        if (/water|bubble_column/.test(name)) {
          let depth = 0
          for (let y = foundY - 1; y >= floor && depth < 8; y--) {
            const below = this.blockNameAt(column, x, y, z)
            if (!/water|bubble_column/.test(below.name)) break
            depth++
          }
          color = shade(color, 1 - depth * 0.07)
        }
        colors[index] = color
      }
    }
    // Relief against the column to the north.
    const northKey = `${cx},${cz - 1}`
    const north = this.topHeights.get(northKey)
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const index = z * 16 + x
        let base = colors[index]
        if (!base) {
          rgb[index * 3] = 14
          rgb[index * 3 + 1] = 16
          rgb[index * 3 + 2] = 20
          continue
        }
        let neighborY = null
        if (z > 0) {
          if (topY[index - 16] !== -32768) neighborY = topY[index - 16]
        } else if (north) {
          const nv = north[x * 16 + 15] // north chunk's southern row
          if (nv !== -32768) neighborY = nv
        }
        if (neighborY !== null && topY[index] !== -32768) {
          if (topY[index] > neighborY) base = shade(base, 1.08)
          else if (topY[index] < neighborY) base = shade(base, 0.92)
        }
        rgb[index * 3] = base[0]
        rgb[index * 3 + 1] = base[1]
        rgb[index * 3 + 2] = base[2]
      }
    }
    this.topHeights.set(`${cx},${cz}`, topY)
    return { cx, cz, rgb: rgb.toString('base64') }
  }
}
