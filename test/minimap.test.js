import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Minimap } from '../src/minimap.js'

const AIR = 0
const STONE = 1
const GRASS = 2
const WATER = 3

function makeRegistry () {
  return { blocksByStateId: [{ name: 'air' }, { name: 'stone' }, { name: 'grass_block' }, { name: 'water' }] }
}

// top: "x,z" -> y of the top solid block. water: "x,z" -> depth of water above
// the solid block (each unit adds one water block).
function makeColumn (tops, waters = new Map()) {
  return {
    getBlockStateId ({ x, y, z }) {
      const key = `${x},${z}`
      const top = tops.get(key) ?? 0
      const water = waters.get(key) ?? 0
      if (water > 0 && y > top && y <= top + water) return WATER
      if (y > top) return AIR
      if (y === top) return GRASS
      if (y >= 0) return STONE
      return AIR
    }
  }
}

function pixel (tile, x, z) {
  const bytes = Buffer.from(tile.rgb, 'base64')
  return [bytes[(z * 16 + x) * 3], bytes[(z * 16 + x) * 3 + 1], bytes[(z * 16 + x) * 3 + 2]]
}

function makeMinimap (tops, waters) {
  const tiles = []
  const minimap = new Minimap({
    bot: {
      on () {},
      removeListener () {},
      world: { getColumn: () => makeColumn(tops, waters) },
      game: { minY: 0, height: 64, dimension: 'overworld' },
      entity: { position: { x: 8, y: 10, z: 8 } }
    },
    registry: makeRegistry(),
    radiusChunks: 6,
    onTiles: batch => tiles.push(...batch),
    onUntile: () => {},
    logger: { warn () {} },
    sliceMs: 5
  })
  return { minimap, tiles }
}

test('tile is 16x16 RGB, rows along z', () => {
  const tops = new Map([['5,5', 4]])
  const { minimap } = makeMinimap(tops)
  const tile = minimap.buildTile(0, 0)
  assert.equal(tile.cx, 0)
  assert.equal(tile.cz, 0)
  assert.equal(Buffer.from(tile.rgb, 'base64').length, 16 * 16 * 3)
  const [r, g, b] = pixel(tile, 5, 5)
  assert.ok(g > r && g > b, `expected greenish grass, got ${r},${g},${b}`)
})

test('relief darkens columns lower than the one to the north', () => {
  const tops = new Map([['5,0', 6], ['5,1', 3], ['5,2', 3]])
  const { minimap } = makeMinimap(tops)
  const tile = minimap.buildTile(0, 0)
  const north = pixel(tile, 5, 0)
  const south = pixel(tile, 5, 1)
  const same = pixel(tile, 5, 2)
  assert.equal(north[1], 170)
  assert.ok(south[1] < north[1], `${south[1]} should be darker than ${north[1]}`)
  // (5,2) is level with (5,1): no relief change
  assert.equal(same[1], 170)
})

test('water gets darker with depth, up to 8 blocks', () => {
  const tops = new Map([['3,3', 0], ['4,4', 0]])
  const waters = new Map([['3,3', 3], ['4,4', 0]])
  // water above the surface block: (3,3) has 3 water blocks, (4,4) has none,
  // so add a second column with exactly one water block.
  waters.set('4,4', 1)
  const { minimap } = makeMinimap(tops, waters)
  const tile = minimap.buildTile(0, 0)
  const deep = pixel(tile, 3, 3)
  const shallow = pixel(tile, 4, 4)
  assert.ok(deep[2] > deep[0], 'water is blue')
  assert.ok(deep[2] < shallow[2], `${deep[2]} should be darker than ${shallow[2]}`)
})

test('queued tiles are built in time slices and handed over in batches', async () => {
  const tops = new Map()
  const { minimap, tiles } = makeMinimap(tops)
  minimap.queueTile(0, 0)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(tiles.length >= 1)
  assert.equal(tiles[0].cx, 0)
  assert.ok(minimap.allTiles().length >= 1)
  minimap.destroy()
})

test('a falling-out-of-range tile is dropped and reported', () => {
  const tops = new Map()
  const dropped = []
  const minimap = new Minimap({
    bot: {
      on () {},
      removeListener () {},
      world: { getColumn: () => makeColumn(tops) },
      game: { minY: 0, height: 64, dimension: 'overworld' },
      entity: { position: { x: 1000, y: 10, z: 1000 } }
    },
    registry: makeRegistry(),
    radiusChunks: 1,
    onTiles: () => {},
    onUntile: batch => dropped.push(...batch),
    logger: { warn () {} }
  })
  minimap.tiles.set('0,0', { cx: 0, cz: 0, rgb: '' })
  minimap.pruneRange()
  assert.deepEqual(dropped, [{ cx: 0, cz: 0 }])
  assert.equal(minimap.tiles.size, 0)
  minimap.destroy()
})

test('refreshAll queues loaded columns and reset drops old tiles', () => {
  const tops = new Map()
  const dropped = []
  const minimap = new Minimap({
    bot: {
      on () {},
      removeListener () {},
      world: {
        getColumn: () => makeColumn(tops),
        getColumns: () => [
          { chunkX: '0', chunkZ: '0', column: {} },
          { chunkX: '1', chunkZ: '-1', column: {} }
        ]
      },
      game: { minY: 0, height: 64, dimension: 'overworld' },
      entity: { position: { x: 8, y: 10, z: 8 } }
    },
    registry: makeRegistry(),
    radiusChunks: 6,
    onTiles: () => {},
    onUntile: batch => dropped.push(...batch),
    logger: { warn () {} }
  })
  minimap.refreshAll()
  assert.equal(minimap.queue.size, 2)
  minimap.tiles.set('0,0', { cx: 0, cz: 0, rgb: '' })
  minimap.tiles.set('1,1', { cx: 1, cz: 1, rgb: '' })
  minimap.reset()
  assert.equal(minimap.tiles.size, 0)
  assert.equal(minimap.queue.size, 0)
  assert.deepEqual(dropped.sort((a, b) => a.cx - b.cx), [{ cx: 0, cz: 0 }, { cx: 1, cz: 1 }])
  minimap.destroy()
})
