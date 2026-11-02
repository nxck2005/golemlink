import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { listZip, readZipEntry } from '../src/zip.js'
import { buildIndex, modelFromItemDefinition, Textures, MANIFEST_URL } from '../src/textures.js'

// A minimal zip writer for fixtures: stored and deflated entries.
function makeZip (files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content, deflate] of files) {
    const data = Buffer.from(content)
    const body = deflate ? zlib.deflateRawSync(data) : data
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, body)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

test('the zip reader lists and inflates entries', () => {
  const zip = makeZip([['a.txt', 'hello', false], ['dir/b.json', '{"x":1}'.repeat(50), true]])
  const entries = listZip(zip)
  assert.deepEqual(entries.map(e => e.name), ['a.txt', 'dir/b.json'])
  assert.equal(readZipEntry(zip, entries[0]).toString(), 'hello')
  assert.equal(readZipEntry(zip, entries[1]).toString(), '{"x":1}'.repeat(50))
  assert.throws(() => listZip(Buffer.from('not a zip at all, definitely not')), /not a zip/)
})

const models = new Map(Object.entries({
  'item/generated': {},
  'item/handheld': { parent: 'item/generated' },
  'item/diamond_sword': { parent: 'minecraft:item/handheld', textures: { layer0: 'minecraft:item/diamond_sword' } },
  'item/compass_16': { parent: 'item/generated', textures: { layer0: 'item/compass_16' } },
  'block/block': {},
  'block/cube': { parent: 'block/block', textures: { particle: '#north', north: '#north', east: '#east', up: '#up' } },
  'block/cube_all': { parent: 'block/cube', textures: { north: '#all', east: '#all', up: '#all' } },
  'block/cube_column': { parent: 'block/cube', textures: { up: '#end', north: '#side', east: '#side' } },
  'block/stone': { parent: 'block/cube_all', textures: { all: 'block/stone' } },
  'block/oak_log': { parent: 'block/cube_column', textures: { end: 'block/oak_log_top', side: 'block/oak_log' } },
  'item/stone': { parent: 'minecraft:block/stone' },
  'item/oak_log': { parent: 'block/oak_log' },
  'item/chest': { parent: 'builtin/entity', textures: { particle: 'block/oak_planks' } },
  'item/missing_texture': { parent: 'item/generated', textures: { layer0: 'item/nope' } }
}))
const textures = new Set(['item/diamond_sword', 'item/compass_16', 'block/stone', 'block/oak_log', 'block/oak_log_top', 'block/oak_planks'])

test('item models resolve to flat sprites, cubes, or nothing', () => {
  const definitions = new Map([['compass', { model: { type: 'minecraft:range_dispatch', entries: [], fallback: { type: 'minecraft:model', model: 'minecraft:item/compass_16' } } }]])
  const items = buildIndex({ models, itemDefinitions: definitions, textures })
  assert.deepEqual(items.diamond_sword, { flat: ['item/diamond_sword'] })
  assert.deepEqual(items.stone, { cube: ['block/stone', 'block/stone', 'block/stone'] })
  assert.deepEqual(items.oak_log, { cube: ['block/oak_log_top', 'block/oak_log', 'block/oak_log'] })
  assert.deepEqual(items.compass, { flat: ['item/compass_16'] })
  assert.equal(items.chest, undefined)
  assert.equal(items.missing_texture, undefined)
})

test('item definitions prefer the fallback model', () => {
  assert.equal(modelFromItemDefinition({ model: { type: 'select', cases: [{ model: { type: 'model', model: 'item/a' } }], fallback: { type: 'model', model: 'item/b' } } }), 'item/b')
  assert.equal(modelFromItemDefinition({ model: { type: 'minecraft:model', model: 'item/c' } }), 'item/c')
  assert.equal(modelFromItemDefinition(null), null)
})

test('a version is downloaded, checked and unpacked once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golemlink-tex-'))
  const jar = makeZip([
    ['assets/minecraft/textures/item/diamond_sword.png', 'png1', false],
    ['assets/minecraft/textures/block/stone.png', 'png2', true],
    ['assets/minecraft/textures/item/../../evil.png', 'x', false],
    ['assets/minecraft/models/item/generated.json', '{}', true],
    ['assets/minecraft/models/item/diamond_sword.json', '{"parent":"item/generated","textures":{"layer0":"item/diamond_sword"}}', true],
    ['net/minecraft/Main.class', 'code', false]
  ])
  const sha1 = crypto.createHash('sha1').update(jar).digest('hex')
  const calls = []
  const json = value => ({ ok: true, json: async () => value })
  const fetch = async url => {
    calls.push(url)
    if (url === MANIFEST_URL) return json({ versions: [{ id: '1.21.11', url: 'https://meta/1.21.11.json' }] })
    if (url === 'https://meta/1.21.11.json') return json({ downloads: { client: { url: 'https://data/client.jar', sha1, size: jar.length } } })
    if (url === 'https://data/client.jar') return { ok: true, arrayBuffer: async () => jar }
    return { ok: false, status: 404 }
  }
  const ready = []
  const tex = new Textures({ dataDir, fetch, onReady: v => ready.push(v), logger: { info () {}, warn () {} } })
  assert.deepEqual(await Promise.all([tex.ensure('1.21.11'), tex.ensure('1.21.11')]), [true, true])
  assert.equal(calls.length, 3)
  assert.deepEqual(ready, ['1.21.11'])
  const dir = path.join(dataDir, 'textures', '1.21.11')
  assert.equal(fs.readFileSync(path.join(dir, 'block', 'stone.png'), 'utf8'), 'png2')
  assert.ok(!fs.existsSync(path.join(dataDir, 'textures', 'evil.png')))
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  assert.deepEqual(index.items.diamond_sword, { flat: ['item/diamond_sword'] })
  assert.deepEqual(new Textures({ dataDir }).ready(), ['1.21.11'])

  assert.equal(await tex.ensure('../etc'), false)
  assert.equal(await tex.ensure('9.9.9'), false)
  assert.equal(await tex.ensure('9.9.9'), false)
  assert.equal(calls.filter(url => url === MANIFEST_URL).length, 2, 'a failed version is not retried right away')
})
