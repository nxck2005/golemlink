// Item tiles and text-contrast helpers. Items draw from the vanilla
// textures the daemon unpacked for the session's Minecraft version, and fall
// back to a two-letter tile. No inline styles: everything goes through CSSOM.

const MATERIALS = [
  [/^diamond|diamond_/, '#7dd3fc'],
  [/^emerald|emerald_/, '#6ee7a8'],
  [/^iron|iron_/, '#d4d4d8'],
  [/^gold|golden_|gold_/, '#fbbf24'],
  [/^netherite|netherite_/, '#3f3f46'],
  [/^copper|copper_/, '#fb923c'],
  [/^redstone|redstone_/, '#ef4444'],
  [/^lapis|lapis_/, '#3b82f6'],
  [/^coal|coal_/, '#52525b'],
  [/^quartz|quartz_/, '#e5e1d8'],
  [/^amethyst|amethyst_/, '#a78bfa'],
  [/wood|planks|log|_log|stick|chest|barrel|crafting/, '#b45309'],
  [/leather/, '#92400e'],
  [/stone|cobble|deepslate|andesite|diorite|granite|tuff|flint|clay/, '#9ca3af'],
  [/wool|carpet|terracotta|concrete/, '#c4b5a5'],
  [/slime/, '#84cc16'],
  [/honey/, '#facc15']
]

export function materialTint (name) {
  for (const [pattern, color] of MATERIALS) {
    if (pattern.test(name)) return color
  }
  return '#6b7280'
}

export function itemCode (name) {
  if (!name) return '??'
  const words = name.replace(/^minecraft:/, '').split('_').filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function channel (value) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance (rgb) {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

function parseHex (hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!match) return null
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

// Chat sits on the surface color, #1a1b1d.
const BG_LUM = luminance([26, 27, 29])
const TEXT = [231, 233, 238]

// Lighten a chat colour until it has at least 4.5:1 contrast on the app
// background (spec: black and dark_blue must be readable).
export function ensureContrast (hex) {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const ratio = (luminance(rgb) + 0.05) / (BG_LUM + 0.05)
  if (ratio >= 4.5) return `rgb(${rgb.join(',')})`
  let mixed = rgb.slice()
  for (let i = 1; i <= 10; i++) {
    const t = i / 10
    mixed = rgb.map((c, index) => Math.round(c + (TEXT[index] - c) * t))
    if ((luminance(mixed) + 0.05) / (BG_LUM + 0.05) >= 4.5) break
  }
  return `rgb(${mixed.join(',')})`
}

// --- textures --------------------------------------------------------------
let texVersion = null
let texIndex = null
const images = new Map() // texture id -> Promise<HTMLImageElement|null>
const rendered = new Map() // item name -> Promise<string|null> (data URL)
const waiting = new Map() // item name -> Set of tiles to fill in
let onIndex = () => {}

export function onTexturesLoaded (fn) {
  onIndex = fn
}

// Point item drawing at one Minecraft version's textures. Only the index is
// fetched here; each PNG loads the first time an item that needs it shows.
export function useTextures (version) {
  if (version === texVersion) return
  texVersion = version
  texIndex = null
  images.clear()
  rendered.clear()
  if (!version) return
  fetch(`textures/${encodeURIComponent(version)}/index.json`, { credentials: 'same-origin' })
    .then(res => res.ok ? res.json() : null)
    .then(json => {
      if (texVersion !== version || !json?.items) return
      texIndex = json.items
      onIndex()
    })
    .catch(() => {})
}

export function texturesVersion () {
  return texIndex ? texVersion : null
}

function loadImage (id) {
  if (!images.has(id)) {
    images.set(id, new Promise(resolve => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = `textures/${encodeURIComponent(texVersion)}/${id}.png`
    }))
  }
  return images.get(id)
}

// Grayscale textures the game colors by biome or dye.
const TINTS = [
  [/^block\/(grass_block_top|short_grass|tall_grass_(top|bottom)|fern|large_fern_(top|bottom)|sugar_cane)$/, '#7cbd6b'],
  [/^block\/spruce_leaves$/, '#619961'],
  [/^block\/birch_leaves$/, '#80a755'],
  [/^block\/(oak|jungle|acacia|dark_oak|mangrove)_leaves$|^block\/vine$/, '#59ae30'],
  [/^block\/lily_pad$/, '#208030'],
  [/^item\/leather_(helmet|chestplate|leggings|boots|horse_armor)$/, '#a06540'],
  [/^item\/potion_overlay$|^item\/splash_potion_overlay|^item\/lingering_potion_overlay/, '#385dc6'],
  [/^item\/tipped_arrow_head$/, '#385dc6']
]

function tintFor (id) {
  for (const [pattern, color] of TINTS) if (pattern.test(id)) return color
  return null
}

// Draws the first animation frame of a texture, tinted if the game tints it.
function frame (img, id) {
  const size = img.width || 16
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, 0, 0, size, size, 0, 0, size, size)
  const tint = tintFor(id)
  if (tint) {
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = tint
    ctx.fillRect(0, 0, size, size)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(img, 0, 0, size, size, 0, 0, size, size)
  }
  return canvas
}

async function renderFlat (layers) {
  const imgs = await Promise.all(layers.map(loadImage))
  if (!imgs[0]) return null
  const size = imgs[0].width || 16
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  imgs.forEach((img, i) => {
    if (img) ctx.drawImage(frame(img, layers[i]), 0, 0, size, size)
  })
  return canvas.toDataURL()
}

// An isometric block: top, left (north) and right (east) faces, with the
// sides shaded like the game's inventory lighting.
async function renderCube ([topId, leftId, rightId]) {
  const [top, left, right] = await Promise.all([topId, leftId, rightId].map(loadImage))
  if (!top || !left || !right) return null
  const S = 64
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  const k = S / 32 // pixels per texel step
  const faces = [
    [frame(top, topId), [k, -k / 2, k, k / 2, 0, S / 4], 0],
    [frame(left, leftId), [k, k / 2, 0, k * 1.0, 0, S / 4], 0.22],
    [frame(right, rightId), [k, -k / 2, 0, k * 1.0, S / 2, S / 2], 0.4]
  ]
  for (const [face, m, shade] of faces) {
    const scale = 16 / face.width
    ctx.setTransform(m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, m[4], m[5])
    ctx.drawImage(face, 0, 0)
    if (shade) {
      ctx.fillStyle = `rgba(0,0,0,${shade})`
      ctx.fillRect(0, 0, face.width, face.height)
    }
  }
  return canvas.toDataURL()
}

function textureFor (name) {
  if (!texIndex) return null
  const entry = texIndex[name]
  if (!entry) return null
  if (!rendered.has(name)) {
    const job = (entry.cube ? renderCube(entry.cube) : renderFlat(entry.flat)).catch(() => null)
    rendered.set(name, job)
    job.then(url => {
      const tiles = waiting.get(name)
      waiting.delete(name)
      if (!url || !tiles) return
      for (const tile of tiles) if (tile.isConnected) paintTexture(tile, url, Boolean(entry.flat))
    })
  }
  return rendered.get(name)
}

function paintTexture (tile, url, flat) {
  tile.textContent = ''
  tile.classList.add('tex')
  tile.classList.toggle('flat', flat)
  tile.style.background = ''
  const img = document.createElement('img')
  img.alt = ''
  img.draggable = false
  img.src = url
  tile.appendChild(img)
}

function itemKey (name) {
  return String(name || '').replace(/^minecraft:/, '')
}

// A slot's contents: the item picture plus count and durability overlays.
export function itemTile (item, { showCount = true } = {}) {
  const frag = document.createDocumentFragment()
  if (!item) return frag
  const name = itemKey(item.n)
  const tile = document.createElement('span')
  tile.className = 'item'
  if (item.ench) tile.classList.add('ench')
  tile.style.background = materialTint(name)
  tile.textContent = itemCode(name)
  frag.appendChild(tile)
  const job = textureFor(name)
  if (job) {
    if (!waiting.has(name)) waiting.set(name, new Set())
    waiting.get(name).add(tile)
    job.then(url => {
      if (url && tile.isConnected && !tile.classList.contains('tex')) paintTexture(tile, url, Boolean(texIndex?.[name]?.flat))
    })
  }
  if (item.dur && item.dur[1] > 0 && item.dur[0] > 0) {
    const dur = document.createElement('span')
    dur.className = 'dur'
    const fill = document.createElement('i')
    const left = 1 - Math.min(1, item.dur[0] / item.dur[1])
    fill.style.width = `${Math.max(0, Math.round(left * 100))}%`
    fill.style.background = `hsl(${Math.round(left * 120)}, 70%, 50%)`
    dur.appendChild(fill)
    frag.appendChild(dur)
  }
  if (showCount && item.c > 1) {
    const count = document.createElement('span')
    count.className = 'count'
    count.textContent = String(item.c)
    frag.appendChild(count)
  }
  return frag
}

export function itemName (item) {
  if (!item) return ''
  return item.cn || item.d || itemKey(item.n).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

export function itemLabel (item) {
  if (!item) return 'empty'
  const name = item.cn || item.d || item.n
  return item.c > 1 ? `${name} ×${item.c}` : name
}
