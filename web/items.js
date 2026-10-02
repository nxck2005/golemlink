// Item tile and text-contrast helpers. No textures, no inline styles:
// everything is set through CSSOM properties.

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

const BG_LUM = luminance([14, 16, 19])
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

export function itemTile (item, { showCount = true } = {}) {
  const tile = document.createElement('div')
  tile.className = 'tile'
  if (!item) return tile
  tile.style.background = materialTint(item.n)
  const code = document.createElement('span')
  code.className = 'code'
  code.textContent = itemCode(item.n)
  tile.appendChild(code)
  if (item.ench) tile.classList.add('ench')
  if (item.dur && item.dur[1] > 0) {
    const dur = document.createElement('div')
    dur.className = 'dur'
    const fill = document.createElement('span')
    const left = 1 - Math.min(1, item.dur[0] / item.dur[1])
    fill.style.width = `${Math.max(0, Math.round(left * 100))}%`
    fill.style.background = left < 0.25 ? 'var(--danger)' : left < 0.5 ? 'var(--warn)' : 'var(--accent)'
    dur.appendChild(fill)
    tile.appendChild(dur)
  }
  if (showCount && item.c > 1) {
    const count = document.createElement('span')
    count.className = 'count'
    count.textContent = String(item.c)
    tile.appendChild(count)
  }
  return tile
}

export function itemLabel (item) {
  if (!item) return 'empty'
  const name = item.cn || item.d || item.n
  return item.c > 1 ? `${name} ×${item.c}` : name
}
