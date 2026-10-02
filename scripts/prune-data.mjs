#!/usr/bin/env node
// Deletes the Bedrock data mineflayer never uses, shrinking node_modules from
// ~471 MB to ~138 MB on a phone. Run again after every `npm ci`.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolveDataDir, loadConfig } from '../src/config.js'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function bedrockDir () {
  try {
    return path.join(path.dirname(require.resolve('minecraft-data/package.json')), 'minecraft-data', 'data', 'bedrock')
  } catch {
    return null
  }
}

function human (bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function dirSize (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

function configuredVersions (argv) {
  const dataDir = resolveDataDir(argv[0] || process.env.GOLEMLINK_DATA_DIR)
  try {
    const { config, errors } = loadConfig(dataDir)
    if (errors.length > 0) return []
    const versions = new Set()
    for (const server of config.servers) {
      if (server.version && server.version !== 'auto') versions.add(server.version)
    }
    return [...versions]
  } catch {
    return []
  }
}

const target = bedrockDir()
if (!target || !fs.existsSync(target)) {
  console.log('prune-data: minecraft-data bedrock directory not found; nothing to do')
  process.exit(0)
}

const before = dirSize(target)
let removed = 0
let kept = 0
for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
  const full = path.join(target, entry.name)
  if (entry.name === 'common') {
    kept += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size
    continue
  }
  const size = entry.isDirectory() ? dirSize(full) : fs.statSync(full).size
  if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true })
  else fs.rmSync(full, { force: true })
  removed += size
}
console.log(`prune-data: removed ${human(removed)} of Bedrock data, kept common/ (${human(kept)}); was ${human(before)}`)

// Prove nothing needed was deleted: load every configured Minecraft version.
const versions = configuredVersions(process.argv.slice(2))
if (versions.length === 0) {
  console.log('prune-data: no configured server versions to verify (any "auto" servers are resolved by mineflayer at runtime)')
} else {
  for (const version of versions) {
    const data = require('minecraft-data')(version)
    if (!data) {
      console.error(`prune-data: FAIL: minecraft-data cannot load configured version ${version}`)
      process.exit(1)
    }
    console.log(`prune-data: ok, minecraft-data loads ${version}`)
  }
}
