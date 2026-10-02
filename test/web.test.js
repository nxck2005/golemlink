import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureContrast, itemCode, materialTint } from '../web/items.js'
import { movementKey, isTypingTarget } from '../web/keyboard.js'

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')

test('item codes are two letters from the item id', () => {
  assert.equal(itemCode('diamond_sword'), 'DS')
  assert.equal(itemCode('stone'), 'ST')
  assert.equal(itemCode('minecraft:iron_pickaxe'), 'IP')
  assert.equal(itemCode(''), '??')
})

test('material tints follow the spec keywords', () => {
  assert.equal(materialTint('diamond_sword'), '#7dd3fc')
  assert.equal(materialTint('iron_ingot'), '#d4d4d8')
  assert.equal(materialTint('golden_apple'), '#fbbf24')
  assert.equal(materialTint('netherite_scrap'), '#3f3f46')
  assert.equal(materialTint('copper_ingot'), '#fb923c')
  assert.equal(materialTint('oak_planks'), '#b45309')
  assert.equal(materialTint('cobblestone'), '#9ca3af')
  assert.equal(materialTint('mystery_item'), '#6b7280')
})

test('dark chat colors are lightened to at least 4.5:1 contrast', () => {
  // #0e1013 is the app background from style.css
  const bg = [14, 16, 19]
  const lum = rgb => {
    const ch = v => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2])
  }
  const ratio = rgb => (Math.max(lum(rgb), lum(bg)) + 0.05) / (Math.min(lum(rgb), lum(bg)) + 0.05)
  for (const color of ['#000000', '#0000aa', '#555555', '#ff5555']) {
    const output = ensureContrast(color)
    const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(output)
    assert.ok(match, output)
    assert.ok(ratio([+match[1], +match[2], +match[3]]) >= 4.5, `${color} -> ${output}`)
  }
})

test('the UI has no inline scripts, handlers or external resources (CSP)', () => {
  const files = ['index.html', 'app.js', 'store.js', 'net.js', 'chat.js', 'move.js', 'keyboard.js', 'bag.js', 'more.js', 'items.js']
  for (const file of files) {
    const text = fs.readFileSync(path.join(webDir, file), 'utf8')
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(text), `${file} references an external URL`)
  }
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8')
  assert.ok(!/\son\w+=/i.test(html), 'index.html has an inline event handler')
  assert.ok(!/\sstyle=/i.test(html), 'index.html has a style attribute')
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'index.html has an inline script')
})

test('every element id used by the UI exists in index.html', () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8')
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]))
  for (const file of fs.readdirSync(webDir)) {
    if (!file.endsWith('.js')) continue
    const text = fs.readFileSync(path.join(webDir, file), 'utf8')
    for (const match of text.matchAll(/getElementById\('([^']+)'\)/g)) {
      assert.ok(ids.has(match[1]), `${file} uses #${match[1]} which is not in index.html`)
    }
  }
})

test('itemTile renders without innerHTML', () => {
  const text = fs.readFileSync(path.join(webDir, 'items.js'), 'utf8')
  assert.ok(!text.includes('innerHTML'))
})

test('WASD and Space map to movement, but shortcuts and IME composition do not', () => {
  for (const [code, control] of Object.entries({ KeyW: 'forward', KeyA: 'left', KeyS: 'back', KeyD: 'right', Space: 'jump' })) {
    assert.equal(movementKey({ code }), control)
    for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(movementKey({ code, [flag]: true }), null)
  }
  assert.equal(movementKey({ code: 'KeyE' }), null)
})

test('typing targets include fields and editable descendants', () => {
  assert.equal(isTypingTarget({ isContentEditable: true }), true)
  assert.equal(isTypingTarget({ closest: () => ({ tagName: 'INPUT' }) }), true)
  assert.equal(isTypingTarget({ closest: () => null }), false)
  assert.equal(isTypingTarget(null), false)
})
