import { store } from './store.js'
import { send } from './net.js'
import { movementKey, isTypingTarget } from './keyboard.js'

const MOMENTARY = ['forward', 'back', 'left', 'right', 'jump']
const controls = Object.fromEntries(MOMENTARY.map(k => [k, false]))
const inputSources = new Map(MOMENTARY.map(key => [key, new Set()]))
const heldPointers = new Map()
const heldKeys = new Map()
let holdTimer = null
let lookPointer = null
let lastLookPoint = { x: 0, y: 0 }
let pendingLook = null
let dragLook = null
let lookTimer = null
let lastLookSent = 0
let zoom = 2
let stepN = 4
let gotoPending = null
let canvas, ctx, dpr = 1
let tileCache = new Map()

function activeSession () {
  return store.sessionId
}

export function sendControl (k, on) {
  if (controls[k] === on) return
  if (on && (!store.connected || store.session()?.state !== 'online')) return
  const sent = send({ t: 'ctl', s: activeSession(), k, on })
  if (on && !sent) return
  controls[k] = on
  for (const button of document.querySelectorAll(`[data-control="${k}"]`)) {
    button.classList.toggle('active', on)
    button.setAttribute('aria-pressed', String(on))
  }
  updateHeartbeat()
}

function setInput (control, source, on) {
  const sources = inputSources.get(control)
  if (on) sources.add(source)
  else sources.delete(source)
  sendControl(control, sources.size > 0)
}

function canMove () {
  return store.connected && store.session()?.state === 'online' &&
    document.getElementById('tab-move').classList.contains('active') &&
    document.getElementById('sheet').classList.contains('hidden')
}

function bindHoldButton (button, control) {
  button.addEventListener('contextmenu', event => event.preventDefault())
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !canMove()) return
    event.preventDefault()
    heldPointers.set(event.pointerId, { button, control })
    button.setPointerCapture(event.pointerId)
    setInput(control, `pointer:${event.pointerId}`, true)
  })
  const release = event => {
    const held = heldPointers.get(event.pointerId)
    if (!held || held.button !== button) return
    heldPointers.delete(event.pointerId)
    setInput(control, `pointer:${event.pointerId}`, false)
  }
  button.addEventListener('pointerup', release)
  button.addEventListener('pointercancel', release)
  button.addEventListener('lostpointercapture', release)
  button.addEventListener('pointermove', event => {
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) release(event)
  })
  button.addEventListener('keydown', event => {
    if (!['Space', 'Enter'].includes(event.code)) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat && canMove()) setInput(control, `button:${button.id}:${event.code}`, true)
  })
  button.addEventListener('keyup', event => {
    if (!['Space', 'Enter'].includes(event.code)) return
    event.preventDefault()
    event.stopPropagation()
    setInput(control, `button:${button.id}:${event.code}`, false)
  })
  button.addEventListener('blur', () => {
    for (const code of ['Space', 'Enter']) setInput(control, `button:${button.id}:${code}`, false)
  })
}

function initKeyboard () {
  document.addEventListener('keydown', event => {
    const control = movementKey(event)
    if (!control || isTypingTarget(event.target) || !canMove()) return
    if (event.code === 'Space' && event.target.closest?.('button, a')) return
    event.preventDefault()
    // Do not resume from an OS repeat after blur, stop, or resync.
    if (event.repeat) return
    heldKeys.set(event.code, control)
    setInput(control, `key:${event.code}`, true)
  })
  document.addEventListener('keyup', event => {
    const control = heldKeys.get(event.code)
    if (!control) return
    heldKeys.delete(event.code)
    setInput(control, `key:${event.code}`, false)
    event.preventDefault()
  }, true) // Release held keys even if focus moved to a button handling keyup.
  document.addEventListener('focusin', event => {
    if (isTypingTarget(event.target)) releaseAllControls(true)
  })
}

function updateHeartbeat () {
  const any = MOMENTARY.some(k => controls[k])
  if (any && !holdTimer) {
    holdTimer = setInterval(() => send({ t: 'hold', s: activeSession() }), 200)
  } else if (!any && holdTimer) {
    clearInterval(holdTimer)
    holdTimer = null
  }
}

export function releaseAllControls (notify = false) {
  const captured = [...heldPointers].map(([pointer, held]) => [held.button, pointer])
  captured.push([document.getElementById('look-pad'), lookPointer])
  heldPointers.clear()
  heldKeys.clear()
  for (const sources of inputSources.values()) sources.clear()
  pendingLook = null
  dragLook = null
  lookPointer = null
  if (lookTimer) clearTimeout(lookTimer)
  lookTimer = null
  for (const k of MOMENTARY) {
    if (controls[k]) {
      controls[k] = false
      if (notify) send({ t: 'ctl', s: activeSession(), k, on: false })
    }
  }
  if (holdTimer) {
    clearInterval(holdTimer)
    holdTimer = null
  }
  for (const button of document.querySelectorAll('[data-control]')) {
    button.classList.remove('active')
    button.setAttribute('aria-pressed', 'false')
  }
  for (const [element, pointer] of captured) {
    if (pointer !== null && element?.hasPointerCapture(pointer)) element.releasePointerCapture(pointer)
  }
}

function applyLook () {
  lookTimer = null
  if (!pendingLook || !store.sessionId) return
  lastLookSent = Date.now()
  send({ t: 'look', s: store.sessionId, yaw: pendingLook.yaw, pitch: pendingLook.pitch })
  pendingLook = null
}

function scheduleLook () {
  if (!pendingLook) return
  const wait = Math.max(0, 50 - (Date.now() - lastLookSent))
  if (wait === 0) applyLook()
  else if (!lookTimer) lookTimer = setTimeout(applyLook, wait)
}

export function initMove () {
  canvas = document.getElementById('map')
  ctx = canvas.getContext('2d')

  for (const button of document.querySelectorAll('[data-control]')) bindHoldButton(button, button.dataset.control)
  initKeyboard()

  // look pad
  const pad = document.getElementById('look-pad')
  pad.addEventListener('contextmenu', e => e.preventDefault())
  pad.addEventListener('pointerdown', event => {
    if (event.button !== 0 || lookPointer !== null || !store.connected || store.session()?.state !== 'online') return
    event.preventDefault()
    lookPointer = event.pointerId
    dragLook = { yaw: store.status?.yaw || 0, pitch: store.status?.pitch || 0 }
    lastLookPoint = { x: event.clientX, y: event.clientY }
    pad.setPointerCapture(event.pointerId)
  })
  pad.addEventListener('pointermove', event => {
    if (event.pointerId !== lookPointer) return
    const dx = event.clientX - lastLookPoint.x
    const dy = event.clientY - lastLookPoint.y
    lastLookPoint = { x: event.clientX, y: event.clientY }
    const status = store.status || { yaw: 0, pitch: 0 }
    const base = dragLook || { yaw: status.yaw || 0, pitch: status.pitch || 0 }
    const sensitivity = 0.006
    pendingLook = {
      yaw: base.yaw - dx * sensitivity,
      pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, base.pitch - dy * sensitivity))
    }
    dragLook = pendingLook
    scheduleLook()
  })
  const endLook = event => {
    if (event.pointerId === lookPointer) lookPointer = null
  }
  pad.addEventListener('pointerup', endLook)
  pad.addEventListener('pointercancel', endLook)
  pad.addEventListener('lostpointercapture', endLook)

  document.getElementById('turn-left').addEventListener('click', () => {
    const status = store.status || { yaw: 0, pitch: 0 }
    pendingLook = { yaw: (status.yaw || 0) + Math.PI / 2, pitch: status.pitch || 0 }
    scheduleLook()
  })
  document.getElementById('turn-right').addEventListener('click', () => {
    const status = store.status || { yaw: 0, pitch: 0 }
    pendingLook = { yaw: (status.yaw || 0) - Math.PI / 2, pitch: status.pitch || 0 }
    scheduleLook()
  })

  // controls
  document.getElementById('btn-sprint').addEventListener('click', () => {
    const on = Boolean(store.status?.ctl?.sprint)
    send({ t: 'ctl', s: activeSession(), k: 'sprint', on: !on })
  })
  document.getElementById('btn-sneak').addEventListener('click', () => {
    const on = Boolean(store.status?.ctl?.sneak)
    send({ t: 'ctl', s: activeSession(), k: 'sneak', on: !on })
  })
  document.getElementById('btn-interact').addEventListener('click', () => send({ t: 'interact', s: activeSession() }))
  document.getElementById('btn-use').addEventListener('click', () => send({ t: 'use', s: activeSession() }))
  document.getElementById('btn-stop').addEventListener('click', () => {
    releaseAllControls(false)
    send({ t: 'stop', s: activeSession() })
  })

  // step
  const stepRow = document.getElementById('step-row')
  stepRow.querySelectorAll('.stepn').forEach(button => {
    button.addEventListener('click', () => {
      stepN = Number(button.dataset.n)
      stepRow.querySelectorAll('.stepn').forEach(b => b.classList.toggle('active', b === button))
    })
  })
  stepRow.querySelector('[data-n="4"]').classList.add('active')
  stepRow.querySelectorAll('.step').forEach(button => {
    button.addEventListener('click', () => send({ t: 'step', s: activeSession(), dir: button.dataset.dir, n: stepN }))
  })

  // map
  canvas.addEventListener('contextmenu', e => e.preventDefault())
  canvas.addEventListener('click', event => mapTap(event))
  document.getElementById('zoom-in').addEventListener('click', () => {
    zoom = Math.min(4, zoom + 1)
    drawMap()
  })
  document.getElementById('zoom-out').addEventListener('click', () => {
    zoom = Math.max(1, zoom - 1)
    drawMap()
  })
  document.getElementById('goto-go').addEventListener('click', () => {
    if (!gotoPending) return
    send({ t: 'goto', s: activeSession(), x: gotoPending.x, z: gotoPending.z })
    hideGotoChip()
  })

  window.addEventListener('resize', resizeCanvas)
  store.on('snapshot', () => {
    hideGotoChip()
    releaseAllControls(true)
    tileCache.clear()
    updateMoveStatus()
    drawMap()
  })
  store.on('session', () => {
    releaseAllControls(false)
    hideGotoChip()
    tileCache.clear()
    updateMoveStatus()
    drawMap()
  })
  store.on('hello', updateMoveStatus)
  store.on('sessions', () => {
    if (store.session()?.state !== 'online') releaseAllControls(true)
    updateMoveStatus()
  })
  store.on('tiles', () => drawMap())
  store.on('status', () => {
    updateMoveStatus()
    drawMap()
  })
  store.on('players', () => drawMap())
  store.on('connection', connected => {
    if (!connected) releaseAllControls(false)
    updateMoveStatus()
  })
  store.on('ctlReset', () => releaseAllControls(false))
  store.on('goto', msg => {
    if (msg.phase === 'failed') hideGotoChip()
  })
  updateMoveStatus()
}

function updateMoveStatus () {
  const status = store.status
  const online = store.connected && store.session()?.state === 'online'
  for (const button of document.querySelectorAll('[data-control], #actions button, #step-row button, #turn-left, #turn-right, #goto-go')) button.disabled = !online
  document.getElementById('btn-sprint').classList.toggle('active', Boolean(status?.ctl?.sprint))
  document.getElementById('btn-sneak').classList.toggle('active', Boolean(status?.ctl?.sneak))
  const target = status?.target
  document.getElementById('looking-at').textContent = target ? `Looking at: ${target.name}` : 'Looking at: –'
}

function resizeCanvas () {
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(rect.width * dpr))
  canvas.height = Math.max(1, Math.round(rect.height * dpr))
  drawMap()
}

function tileCanvas (tile) {
  const cacheKey = `${tile.cx},${tile.cz}`
  const cached = tileCache.get(cacheKey)
  if (cached && cached.rgb === tile.rgb) return cached.canvas
  const raw = atob(tile.rgb)
  const bytes = new Uint8ClampedArray(16 * 16 * 4)
  for (let i = 0; i < 16 * 16; i++) {
    bytes[i * 4] = raw.charCodeAt(i * 3)
    bytes[i * 4 + 1] = raw.charCodeAt(i * 3 + 1)
    bytes[i * 4 + 2] = raw.charCodeAt(i * 3 + 2)
    bytes[i * 4 + 3] = 255
  }
  const tileCanvasEl = document.createElement('canvas')
  tileCanvasEl.width = 16
  tileCanvasEl.height = 16
  tileCanvasEl.getContext('2d').putImageData(new ImageData(bytes, 16, 16), 0, 0)
  tileCache.set(cacheKey, { rgb: tile.rgb, canvas: tileCanvasEl })
  if (tileCache.size > 800) {
    const first = tileCache.keys().next().value
    tileCache.delete(first)
  }
  return tileCanvasEl
}

function drawMap () {
  if (!ctx || !canvas) return
  const width = canvas.width
  const height = canvas.height
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#0e1013'
  ctx.fillRect(0, 0, width, height)
  const bot = store.status
  if (!bot) return
  const scale = zoom * dpr
  const cx = width / 2
  const cy = height / 2
  for (const tile of store.tiles.values()) {
    const image = tileCanvas(tile)
    const sx = cx + (tile.cx * 16 - bot.x) * scale
    const sy = cy + (tile.cz * 16 - bot.z) * scale
    ctx.drawImage(image, sx, sy, 16 * scale, 16 * scale)
  }
  // players
  for (const player of store.players) {
    if (typeof player.x !== 'number') continue
    ctx.fillStyle = '#60a5fa'
    const px = cx + (player.x - bot.x) * scale
    const py = cy + (player.z - bot.z) * scale
    ctx.beginPath()
    ctx.arc(px, py, Math.max(3, 2.5 * dpr), 0, Math.PI * 2)
    ctx.fill()
  }
  // bot arrow (yaw 0 = north = -z = up; rotate by -yaw)
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(-(bot.yaw || 0))
  ctx.fillStyle = '#4ade80'
  const size = Math.max(6, 5 * dpr) * zoom / 2
  ctx.beginPath()
  ctx.moveTo(0, -size)
  ctx.lineTo(size * 0.7, size)
  ctx.lineTo(-size * 0.7, size)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function mapTap (event) {
  const bot = store.status
  if (!bot) return
  const rect = canvas.getBoundingClientRect()
  const scale = zoom
  const sx = event.clientX - rect.left - rect.width / 2
  const sy = event.clientY - rect.top - rect.height / 2
  const worldX = bot.x + sx / scale
  const worldZ = bot.z + sy / scale
  // tap on a player dot shows the name
  for (const player of store.players) {
    if (typeof player.x !== 'number') continue
    const px = (player.x - bot.x) * scale
    const py = (player.z - bot.z) * scale
    if (Math.hypot(sx - px, sy - py) < 16) {
      window.dispatchEvent(new CustomEvent('golemlink-toast', { detail: `${player.name}${player.ping != null ? ` · ${player.ping} ms` : ''}` }))
      return
    }
  }
  showGotoChip(worldX, worldZ)
}

function showGotoChip (x, z) {
  gotoPending = { x: Math.round(x), z: Math.round(z) }
  document.getElementById('goto-text').textContent = `Go to ${gotoPending.x}, ${gotoPending.z}`
  document.getElementById('goto-chip').classList.remove('hidden')
}

function hideGotoChip () {
  gotoPending = null
  document.getElementById('goto-chip').classList.add('hidden')
}

export function onResize () {
  resizeCanvas()
}

export function hasMomentary () {
  return MOMENTARY.some(k => controls[k])
}

export function currentMoveState () {
  return { ...controls }
}
