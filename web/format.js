// Small text helpers shared by the shell, Play and Setup.

export function sessionName (id) {
  return String(id || '').replace('@', ' @ ')
}

export function duration (ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  if (minutes < 1) return 'less than a minute'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${mins}m`
  return `${mins}m`
}

export function seconds (ms) {
  return `${Math.max(0, Math.ceil(ms / 1000))} s`
}

export function ago (at, now = Date.now()) {
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export function clock (at) {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// One short line saying how a session is doing.
export function sessionStatus (session, now = Date.now()) {
  if (!session) return ''
  if (session.pendingMsa) return 'Waiting for Microsoft sign-in'
  switch (session.state) {
    case 'online':
      return session.onlineAt ? `Online for ${duration(now - session.onlineAt)}` : 'Online'
    case 'connecting':
      return 'Connecting'
    case 'reconnecting':
      return session.retryAt && session.retryAt > now ? `Reconnecting in ${seconds(session.retryAt - now)}` : 'Reconnecting'
    default:
      return session.reason && session.reason !== 'stopped' ? `Stopped, ${session.reason}` : 'Stopped'
  }
}

export function dotClass (session) {
  if (!session) return 'dot off'
  if (session.pendingMsa) return 'dot msa'
  return `dot ${session.state === 'stopped' ? 'off' : session.state}`
}

export function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = text
  return node
}

export function icon (name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.appendChild(use)
  return svg
}
