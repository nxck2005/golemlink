const KEY_CONTROLS = { KeyW: 'forward', KeyA: 'left', KeyS: 'back', KeyD: 'right', Space: 'jump' }

export function movementKey (event) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null
  return KEY_CONTROLS[event.code] || null
}

export function isTypingTarget (target) {
  return Boolean(target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
}
