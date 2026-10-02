import { store } from './store.js'
import { send } from './net.js'
import { ensureContrast } from './items.js'

let log, jumpButton, form, input, suggestionBox
let autoScroll = true
let tabTimer = null
let searchInput

function matchesSearch (line) {
  const text = line.plain || (line.segs || []).map(seg => seg.x).join('')
  return text.toLowerCase().includes(searchInput.value.trim().toLowerCase())
}

function renderChat () {
  log.textContent = ''
  const matching = store.chat.filter(matchesSearch)
  for (const line of matching) log.appendChild(makeLine(line))
  log.classList.toggle('hidden', store.chat.length === 0)
  const empty = document.getElementById('chat-empty')
  empty.classList.toggle('hidden', store.chat.length > 0)
  empty.querySelector('h2').textContent = store.sessionId ? 'You’re connected to your adventure' : 'Your next adventure starts here'
  empty.querySelector('p').textContent = store.sessionId ? 'Messages will appear here when the server sends them. You can send a message or /command below once your bot is online.' : 'Add an account and a server, then start a session. Your bot stays connected even when you close this page.'
  document.getElementById('setup-open').textContent = store.sessionId ? 'Manage sessions →' : 'Set up your first session →'
  if (store.chat.length && !matching.length) {
    const message = document.createElement('div')
    message.className = 'muted'
    message.textContent = 'No messages match your search.'
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

function makeLine (line) {
  const row = document.createElement('div')
  row.className = 'chat-line' + (line.echo ? ' echo' : '')
  const time = document.createElement('span')
  time.className = 'ts'
  time.textContent = new Date(line.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  row.appendChild(time)
  const segments = line.segs && line.segs.length ? line.segs : [{ x: line.plain || '' }]
  for (const seg of segments) {
    const span = document.createElement('span')
    span.textContent = seg.x
    if (seg.c) span.style.color = ensureContrast(seg.c)
    if (seg.b) span.style.fontWeight = '700'
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

  store.on('snapshot', () => {
    renderChat()
    updateComposer()
    autoScroll = true
  })
  store.on('session', () => {
    clearTimeout(tabTimer)
    input.value = ''
    searchInput.value = ''
    renderSuggestions([])
    renderChat()
    updateComposer()
  })
  store.on('sessions', updateComposer)
  store.on('hello', updateComposer)
  store.on('connection', updateComposer)
  store.on('chat', line => appendLine(line))
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
