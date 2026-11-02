import { store } from './store.js'
import { send } from './net.js'
import { ensureContrast } from './items.js'
import { serverFor } from './play.js'

let log, jumpButton, form, input, suggestionBox
let autoScroll = true
let tabTimer = null
let searchInput

function matchesSearch (line) {
  return lineText(line).toLowerCase().includes(searchInput.value.trim().toLowerCase())
}

const recentListeners = new Set()

// Calls fn whenever the chat changes, so Play can show the last few lines.
export function onChatChange (fn) {
  recentListeners.add(fn)
}

export function recentLines (n = 4) {
  return store.chat.slice(-n)
}

function chatChanged () {
  for (const fn of recentListeners) fn()
}

function lineText (line) {
  return line.plain || (line.segs || []).map(seg => seg.x).join('')
}

// Lines that match the server's alert keywords get highlighted.
function isMention (line) {
  if (line.echo) return false
  const keywords = serverFor()?.alerts?.keywords || []
  if (!keywords.length) return false
  const text = lineText(line).toLowerCase()
  return keywords.some(k => k && text.includes(String(k).toLowerCase()))
}

function renderChat () {
  log.textContent = ''
  const matching = store.chat.filter(matchesSearch)
  for (const line of matching) log.appendChild(makeLine(line))
  log.classList.toggle('hidden', store.chat.length === 0)
  const empty = document.getElementById('chat-empty')
  empty.classList.toggle('hidden', store.chat.length > 0)
  empty.textContent = store.sessionId ? 'Messages from the server appear here.' : 'Start a session to see chat.'
  if (store.chat.length && !matching.length) {
    const message = document.createElement('div')
    message.className = 't3'
    message.textContent = 'No messages match your search'
    log.appendChild(message)
  }
  log.scrollTop = log.scrollHeight
  jumpButton.classList.add('hidden')
}

function updateComposer () {
  const online = store.connected && store.session()?.state === 'online'
  input.disabled = !online
  document.getElementById('chat-send').disabled = !online
  input.placeholder = online ? 'Message or /command' : 'Start an online session to chat'
}

function nearBottom () {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40
}

export function makeLine (line) {
  const row = document.createElement('div')
  row.className = 'chat-line' + (line.echo ? ' echo' : '') + (isMention(line) ? ' mention' : '')
  const time = document.createElement('span')
  time.className = 'ts'
  time.textContent = new Date(line.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  row.appendChild(time)
  const segments = line.segs && line.segs.length ? line.segs : [{ x: line.plain || '' }]
  for (const seg of segments) {
    const span = document.createElement('span')
    span.textContent = seg.x
    if (seg.c) span.style.color = ensureContrast(seg.c)
    if (seg.b) span.style.fontWeight = '600'
    if (seg.i) span.style.fontStyle = 'italic'
    if (seg.u || seg.s) {
      const parts = []
      if (seg.u) parts.push('underline')
      if (seg.s) parts.push('line-through')
      span.style.textDecoration = parts.join(' ')
    }
    if (seg.o) span.style.opacity = '0.7'
    row.appendChild(span)
  }
  return row
}

function appendLine (line) {
  if (searchInput.value || log.classList.contains('hidden')) {
    renderChat()
    return
  }
  const stick = nearBottom()
  log.appendChild(makeLine(line))
  while (log.childElementCount > 500) log.removeChild(log.firstElementChild)
  if (stick) log.scrollTop = log.scrollHeight
  jumpButton.classList.toggle('hidden', nearBottom())
}

function renderSuggestions (items) {
  suggestionBox.textContent = ''
  if (!items || items.length === 0) {
    suggestionBox.classList.add('hidden')
    return
  }
  for (const item of items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chip'
    button.textContent = item
    button.addEventListener('click', () => {
      input.value = item
      suggestionBox.classList.add('hidden')
      input.focus()
    })
    suggestionBox.appendChild(button)
  }
  suggestionBox.classList.remove('hidden')
}

export function initChat () {
  log = document.getElementById('chat-log')
  jumpButton = document.getElementById('jump-latest')
  form = document.getElementById('chat-form')
  input = document.getElementById('chat-input')
  suggestionBox = document.getElementById('suggestions')
  searchInput = document.getElementById('chat-search')
  searchInput.addEventListener('input', renderChat)
  const searchRow = document.getElementById('chat-search-row')
  const searchToggle = document.getElementById('chat-search-toggle')
  searchToggle.addEventListener('click', () => {
    const open = searchRow.classList.toggle('hidden') === false
    searchToggle.setAttribute('aria-expanded', String(open))
    if (open) searchInput.focus()
    else if (searchInput.value) {
      searchInput.value = ''
      renderChat()
    }
  })

  store.on('snapshot', () => {
    renderChat()
    updateComposer()
    autoScroll = true
    chatChanged()
  })
  store.on('session', () => {
    clearTimeout(tabTimer)
    input.value = ''
    searchInput.value = ''
    renderSuggestions([])
    renderChat()
    updateComposer()
    chatChanged()
  })
  store.on('sessions', updateComposer)
  store.on('hello', updateComposer)
  store.on('connection', updateComposer)
  store.on('chat', line => {
    appendLine(line)
    chatChanged()
  })
  store.on('tab', msg => {
    if (msg.s === store.sessionId) renderSuggestions(msg.items)
  })

  log.addEventListener('scroll', () => {
    autoScroll = nearBottom()
    jumpButton.classList.toggle('hidden', autoScroll)
  })
  jumpButton.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight
    jumpButton.classList.add('hidden')
  })

  input.addEventListener('input', () => {
    if (tabTimer) clearTimeout(tabTimer)
    if (!input.value.startsWith('/') || !store.features.tabComplete) {
      suggestionBox.classList.add('hidden')
      return
    }
    tabTimer = setTimeout(() => {
      if (store.sessionId) send({ t: 'tab', s: store.sessionId, text: input.value })
    }, 250)
  })

  form.addEventListener('submit', event => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text || !store.sessionId) return
    if (send({ t: 'chat', s: store.sessionId, text })) {
      input.value = ''
      suggestionBox.classList.add('hidden')
    }
  })
  renderChat()
  updateComposer()
}

export function appendSystemLine (text) {
  if (!log) return
  appendLine({ ts: Date.now(), plain: text, segs: [{ x: text }] })
}
