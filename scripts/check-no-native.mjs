#!/usr/bin/env node
// Fails if any installed npm package contains native build artifacts, so the
// dependency tree keeps working on Termux without a compiler.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modulesDir = path.join(root, 'node_modules')

const failures = []
const warnings = []
const seen = new Set()

function scanPackageDir (dir, label) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return
  }
  const name = pkg.name || label
  if (seen.has(dir)) return
  seen.add(dir)

  if (pkg.gypfile === true) {
    failures.push(`${name}: package.json sets "gypfile": true`)
  }
  if (fs.existsSync(path.join(dir, 'binding.gyp'))) {
    failures.push(`${name}: contains binding.gyp`)
  }
  for (const file of walk(dir, 6)) {
    if (file.endsWith('.node')) {
      failures.push(`${name}: contains prebuilt native addon ${path.relative(dir, file)}`)
    }
  }
  const scripts = pkg.scripts || {}
  for (const key of ['preinstall', 'install', 'postinstall']) {
    if (typeof scripts[key] === 'string' && scripts[key].trim() !== '') {
      warnings.push(`${name}: has an "${key}" install script (${scripts[key]})`)
    }
  }
}

function * walk (dir, depth) {
  if (depth < 0) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      yield * walk(full, depth - 1)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

if (!fs.existsSync(modulesDir)) {
  console.error('check-no-native: node_modules not found; run npm ci first')
  process.exit(1)
}

for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  if (entry.name.startsWith('@')) {
    const scope = path.join(modulesDir, entry.name)
    for (const sub of fs.readdirSync(scope, { withFileTypes: true })) {
      if (sub.isDirectory()) scanPackageDir(path.join(scope, sub.name), `${entry.name}/${sub.name}`)
    }
  } else if (entry.name !== '.bin') {
    scanPackageDir(path.join(modulesDir, entry.name), entry.name)
  }
}

for (const warning of warnings) console.warn(`check-no-native: warn: ${warning}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`check-no-native: FAIL: ${failure}`)
  process.exit(1)
}

console.log(`check-no-native: ok (${seen.size} packages scanned${warnings.length ? `, ${warnings.length} install-script warning(s)` : ''})`)
