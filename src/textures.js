import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { listZip, readZipEntry } from './zip.js'

export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const VERSION_RE = /^[0-9a-z][0-9a-z._-]{0,31}$/i
const RETRY_MS = 60 * 60 * 1000
const MAX_JAR = 200 * 1024 * 1024
const TEXTURE_RE = /^assets\/minecraft\/textures\/(item|block)\/([a-z0-9_]+)\.png$/
const MODEL_RE = /^assets\/minecraft\/models\/((?:item|block)\/[a-z0-9_/]+)\.json$/
const ITEM_DEF_RE = /^assets\/minecraft\/items\/([a-z0-9_]+)\.json$/

function stripNamespace (ref) {
  let id = String(ref || '').replace(/^minecraft:/, '')
  if (id && !id.includes('/')) id = `block/${id}`
  return id
}

// The first plain model an item definition (1.21.4+) points at, preferring
// fallbacks, which are the "no special state" look.
export function modelFromItemDefinition (def) {
  const seen = new Set()
  const visit = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null
    seen.add(node)
    if (node.type?.replace?.(/^minecraft:/, '') === 'model' && typeof node.model === 'string') return node.model
    if (node.fallback) {
      const found = visit(node.fallback)
      if (found) return found
    }
    for (const value of Object.values(node)) {
      const found = Array.isArray(value) ? value.map(visit).find(Boolean) : visit(value)
      if (found) return found
    }
    return null
  }
  return visit(def?.model ?? def)
}

// Works out how to draw each item from the vanilla models: a flat sprite for
// generated/handheld items, an isometric cube for block items, nothing for
// entity-rendered items (chests, beds, heads), which fall back to letters.
export function buildIndex ({ models, itemDefinitions = new Map(), textures }) {
  const chainOf = ref => {
    const chain = []
    let id = stripNamespace(ref)
    while (id && chain.length < 16 && !chain.some(entry => entry.id === id)) {
      const model = models.get(id)
      chain.push({ id, model })
      if (!model?.parent) break
      id = stripNamespace(model.parent)
    }
    return chain
  }
  const texturesOf = chain => {
    const merged = {}
    for (let i = chain.length - 1; i >= 0; i--) Object.assign(merged, chain[i].model?.textures || {})
    const resolve = key => {
      let value = merged[key]
      for (let i = 0; i < 8 && typeof value === 'string' && value.startsWith('#'); i++) value = merged[value.slice(1)]
      if (typeof value !== 'string' || value.startsWith('#')) return null
      const id = stripNamespace(value)
      return textures.has(id) ? id : null
    }
    return resolve
  }
  const first = (resolve, keys) => {
    for (const key of keys) {
      const value = resolve(key)
      if (value) return value
    }
    return null
  }

  const names = new Set()
  for (const id of models.keys()) if (id.startsWith('item/') && !id.slice(5).includes('/')) names.add(id.slice(5))
  for (const name of itemDefinitions.keys()) names.add(name)

  const items = {}
  for (const name of [...names].sort()) {
    let ref = `item/${name}`
    if (itemDefinitions.has(name)) ref = modelFromItemDefinition(itemDefinitions.get(name)) || ref
    if (!models.has(stripNamespace(ref)) && models.has(`item/${name}`)) ref = `item/${name}`
    const chain = chainOf(ref)
    const ids = chain.map(entry => entry.id)
    const resolve = texturesOf(chain)
    if (ids.some(id => /^builtin\/entity$/.test(id))) continue
    if (ids.some(id => /^item\/(generated|handheld)/.test(id))) {
      const layers = ['layer0', 'layer1', 'layer2'].map(resolve).filter(Boolean)
      if (layers.length) items[name] = { flat: layers }
      continue
    }
    if (ids.some(id => id.startsWith('block/'))) {
      const fill = ['all', 'texture', 'wall', 'side', 'particle']
      const top = first(resolve, ['up', 'top', 'end', ...fill])
      const left = first(resolve, ['north', 'front', ...fill])
      const right = first(resolve, ['east', ...fill])
      if (top && left && right) items[name] = { cube: [top, left, right] }
    }
  }
  return items
}

export class Textures {
  constructor ({ dataDir, logger, fetch = globalThis.fetch, onReady } = {}) {
    this.root = path.join(dataDir, 'textures')
    this.logger = logger
    this.fetch = fetch
    this.onReady = onReady || (() => {})
    this.pending = new Map()
    this.failedAt = new Map()
    this.versions = new Set()
    try {
      for (const name of fs.readdirSync(this.root)) {
        if (VERSION_RE.test(name) && fs.existsSync(path.join(this.root, name, 'index.json'))) this.versions.add(name)
      }
    } catch {}
  }

  ready () {
    return [...this.versions].sort()
  }

  // Downloads and unpacks the textures for a Minecraft version once. Never
  // throws: failures are logged and retried at most once an hour.
  ensure (version) {
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return Promise.resolve(false)
    if (this.versions.has(version)) return Promise.resolve(true)
    if (this.pending.has(version)) return this.pending.get(version)
    if (Date.now() - (this.failedAt.get(version) || 0) < RETRY_MS) return Promise.resolve(false)
    const job = this.install(version)
      .then(() => {
        this.versions.add(version)
        this.logger?.info?.(`item textures for ${version} ready`)
        this.onReady(version)
        return true
      })
      .catch(err => {
        this.failedAt.set(version, Date.now())
        this.logger?.warn?.(`cannot fetch item textures for ${version}: ${err.message}`)
        return false
      })
      .finally(() => this.pending.delete(version))
    this.pending.set(version, job)
    return job
  }

  async getJson (url) {
    const res = await this.fetch(url)
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    return res.json()
  }

  async install (version) {
    const manifest = await this.getJson(MANIFEST_URL)
    const entry = manifest?.versions?.find(v => v.id === version)
    if (!entry?.url) throw new Error(`Mojang has no client for version ${version}`)
    const meta = await this.getJson(entry.url)
    const client = meta?.downloads?.client
    if (!client?.url || !/^https:\/\//.test(client.url)) throw new Error('version metadata has no client download')
    if (client.size > MAX_JAR) throw new Error('client jar is unexpectedly large')
    this.logger?.info?.(`downloading the ${version} client jar (${Math.round((client.size || 0) / 1048576)} MB) for item textures`)
    const res = await this.fetch(client.url)
    if (!res.ok) throw new Error(`client jar download answered ${res.status}`)
    const jar = Buffer.from(await res.arrayBuffer())
    if (client.sha1) {
      const sha1 = crypto.createHash('sha1').update(jar).digest('hex')
      if (sha1 !== client.sha1) throw new Error('client jar checksum mismatch')
    }
    this.unpack(version, jar)
  }

  unpack (version, jar) {
    const dir = path.join(this.root, version)
    const tmp = `${dir}.${process.pid}.tmp`
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(path.join(tmp, 'item'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'block'), { recursive: true })
    const models = new Map()
    const itemDefinitions = new Map()
    const textures = new Set()
    for (const entry of listZip(jar)) {
      let match = TEXTURE_RE.exec(entry.name)
      if (match) {
        fs.writeFileSync(path.join(tmp, match[1], `${match[2]}.png`), readZipEntry(jar, entry))
        textures.add(`${match[1]}/${match[2]}`)
        continue
      }
      match = MODEL_RE.exec(entry.name) || ITEM_DEF_RE.exec(entry.name)
      if (!match) continue
      try {
        const json = JSON.parse(readZipEntry(jar, entry).toString('utf8'))
        if (entry.name.includes('/models/')) models.set(match[1], json)
        else itemDefinitions.set(match[1], json)
      } catch {}
    }
    if (textures.size === 0) throw new Error('the client jar has no item textures')
    const items = buildIndex({ models, itemDefinitions, textures })
    fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify({ version, items }))
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(tmp, dir)
  }
}
