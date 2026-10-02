import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeItem, itemShape, windowShape, InventoryMirror } from '../src/inventory.js'
import { testRegistry } from './helpers.mjs'

const registry = testRegistry('1.21.11')

// pre-1.20.5 NBT shape (prismarine-item getters read these)
const nbtItem = {
  name: 'diamond_sword',
  displayName: 'Diamond Sword',
  count: 1,
  customName: '{"text":"Excalibur","color":"red"}',
  customLore: ['§7Line one', '§7Line two'],
  durabilityUsed: 10,
  maxDurability: 1561,
  enchants: [{ name: 'sharpness', lvl: 5 }]
}

test('describeItem handles NBT names and lore', () => {
  const info = describeItem(nbtItem, registry)
  assert.equal(info.name, 'Excalibur')
  assert.deepEqual(info.lore, ['Line one', 'Line two'])
  assert.deepEqual(info.dur, [10, 1561])
  assert.equal(info.ench, true)
  const shape = itemShape(nbtItem, registry)
  assert.deepEqual(Object.keys(shape).sort(), ['c', 'cn', 'd', 'dur', 'ench', 'lore', 'n'])
  assert.equal(shape.n, 'diamond_sword')
  assert.equal(shape.cn, 'Excalibur')
  assert.equal(shape.c, 1)
})

// 1.20.5+ data components (componentMap is what prismarine-item exposes)
function componentItem (components) {
  return {
    name: 'diamond_sword',
    displayName: 'Diamond Sword',
    count: 3,
    componentMap: new Map(Object.entries(components).map(([type, data]) => [type, { type, data }])),
    customLore: null,
    durabilityUsed: null,
    maxDurability: 0,
    enchants: []
  }
}

test('describeItem prefers custom_name over item_name over displayName', () => {
  const both = componentItem({
    custom_name: { text: 'Menu Custom' },
    item_name: { text: 'Plugin Name' }
  })
  assert.equal(describeItem(both, registry).name, 'Menu Custom')

  const onlyItemName = componentItem({ item_name: { text: 'Plugin Name' } })
  assert.equal(describeItem(onlyItemName, registry).name, 'Plugin Name')

  const neither = componentItem({})
  assert.equal(describeItem(neither, registry).name, 'Diamond Sword')
})

test('describeItem handles component lore, damage and enchantments', () => {
  const base = componentItem({
    lore: [{ text: 'First' }, { text: 'Second', color: 'gray' }],
    damage: 42,
    enchantments: [{ type: 'sharpness', level: 3 }]
  })
  const item = { ...base, customLore: [{ text: 'First' }, { text: 'Second', color: 'gray' }] }
  item.maxDurability = 100
  const info = describeItem(item, registry)
  assert.deepEqual(info.lore, ['First', 'Second'])
  assert.deepEqual(info.dur, [42, 100])
  assert.equal(info.ench, true)
})

test('empty items are null and windows serialize titles', () => {
  assert.equal(itemShape(null, registry), null)
  const window = {
    id: 3,
    type: 'minecraft:generic_9x3',
    title: { text: 'Chest' },
    slots: [null, itemShape(nbtItem, registry)],
    inventoryStart: 27,
    hotbarStart: 54
  }
  const shape = windowShape(window, registry)
  assert.equal(shape.id, 3)
  assert.equal(shape.title.plain, 'Chest')
  assert.equal(shape.size, 2)
  assert.equal(shape.invStart, 27)
})

test('cursor-only updates are sent even when no inventory slots change', async () => {
  const messages = []
  const mirror = new InventoryMirror({
    bot: { currentWindow: { id: 7 } }, registry, sessionId: 'main@lobby',
    sendToSubscribers: msg => messages.push(msg), debounceMs: 1
  })
  const cursor = { n: 'stone', c: 4 }
  mirror.queueCursor(cursor)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(messages, [{ t: 'inv', s: 'main@lobby', window: 7, slots: {}, cursor }])
  mirror.queueCursor(null)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(messages.at(-1).cursor, null)
  assert.equal(messages.length, 2)
  mirror.flush()
  assert.equal(messages.length, 2, 'flush must not resend a cursor update')
})
