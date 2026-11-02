// What the server shows around the game: boss bars and the sidebar
// scoreboard on Play, and the Server view with the tab list.
import { store } from './store.js'
import { ensureContrast } from './items.js'
import { el } from './format.js'

const COLLAPSED_LINES = 5
const BAR_COLORS = {
  pink: '#d9719f',
  blue: '#5b8fd9',
  red: '#d9675d',
  green: '#7cb97c',
  yellow: '#d9c45c',
  purple: '#b765d6',
  white: '#d8d6d0'
}

let expanded = false

// Server text keeps its Minecraft colours, lifted for contrast like chat.
export function appendSegs (parent, segs) {
  for (const seg of segs || []) {
    const span = document.createElement('span')
    span.textContent = seg.x
    if (seg.c) span.style.color = ensureContrast(seg.c)
    if (seg.b) span.style.fontWeight = '600'
    if (seg.i) span.style.fontStyle = 'italic'
    if (seg.u || seg.s) span.style.textDecoration = [seg.u && 'underline', seg.s && 'line-through'].filter(Boolean).join(' ')
    if (seg.o) span.style.opacity = '0.7'
    parent.appendChild(span)
  }
  return parent
}

export function plainOf (segs) {
  return (segs || []).map(seg => seg.x).join('')
}

function blank (segs) {
  return !plainOf(segs).trim()
}

function online () {
  return store.session()?.state === 'online'
}

// --- boss bars -------------------------------------------------------------
function renderBars (box) {
  box.textContent = ''
  const bars = online() ? store.board?.bars || [] : []
  box.classList.toggle('hidden', !bars.length)
  for (const bar of bars) {
    const row = el('div', 'boss')
    const top = el('div', 'boss-top')
    const title = appendSegs(el('span', 'boss-title'), bar.segs)
    title.title = plainOf(bar.segs)
    top.append(title, el('span', 't3 num', `${Math.round(bar.health * 100)}%`))
    const track = el('div', 'boss-bar')
    const fill = el('i')
    fill.style.width = `${bar.health * 100}%`
    fill.style.background = BAR_COLORS[bar.color] || BAR_COLORS.white
    track.appendChild(fill)
    row.append(top, track)
    box.appendChild(row)
  }
}

// --- scoreboard ------------------------------------------------------------
function sidebarLines (sidebar, limit = Infinity) {
  const box = el('div', 'sb')
  for (const line of sidebar.lines.slice(0, limit)) {
    if (blank(line.segs) && !line.score && !line.scoreSegs) {
      box.appendChild(el('div', 'sb-gap'))
      continue
    }
    const row = el('div', 'sb-line')
    const text = appendSegs(el('span', 'sb-text'), line.segs)
    text.title = plainOf(line.segs)
    row.appendChild(text)
    if (line.scoreSegs) row.appendChild(appendSegs(el('span', 'sb-score'), line.scoreSegs))
    else if (line.score != null) {
      const score = el('span', 'sb-score num', line.score)
      score.style.color = ensureContrast(line.sc || '#ff5555')
      row.appendChild(score)
    }
    box.appendChild(row)
  }
  return box
}

function sidebarTitle (sidebar) {
  const title = appendSegs(el('div', 'sb-title'), sidebar.title)
  if (blank(sidebar.title)) title.classList.add('hidden')
  return title
}

function renderPlayCard () {
  const card = document.getElementById('board-card')
  const sidebar = online() ? store.board?.sidebar : null
  card.classList.toggle('hidden', !sidebar)
  card.textContent = ''
  if (!sidebar) return
  const collapsible = sidebar.lines.length > COLLAPSED_LINES + 1
  card.classList.toggle('collapsed', collapsible && !expanded)
  card.append(sidebarTitle(sidebar), sidebarLines(sidebar))
  if (collapsible) {
    const hidden = sidebar.lines.length - COLLAPSED_LINES
    const more = el('button', 'sb-more phone-only', expanded ? 'Show fewer lines' : `Show ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`)
    more.type = 'button'
    more.setAttribute('aria-expanded', String(expanded))
    more.addEventListener('click', () => {
      expanded = !expanded
      renderPlayCard()
    })
    card.appendChild(more)
  }
}

// --- server view -----------------------------------------------------------
function renderServerBoard () {
  const panel = document.getElementById('server-board')
  panel.textContent = ''
  const sidebar = store.board?.sidebar
  if (!online()) {
    panel.appendChild(el('p', 't2 small', store.sessionId ? 'The scoreboard appears once the bot is online.' : 'Start a session to see the server.'))
    return
  }
  if (!sidebar) {
    panel.appendChild(el('p', 't2 small', 'This server doesn’t show a scoreboard.'))
    return
  }
  panel.append(sidebarTitle(sidebar), sidebarLines(sidebar))
}

function renderTab () {
  const tab = online() ? store.board?.tab : null
  const header = document.getElementById('tab-header')
  const footer = document.getElementById('tab-footer')
  header.textContent = ''
  footer.textContent = ''
  header.classList.toggle('hidden', !tab || blank(tab.header))
  footer.classList.toggle('hidden', !tab || blank(tab.footer))
  if (tab) {
    appendSegs(header, tab.header)
    appendSegs(footer, tab.footer)
  }

  const list = document.getElementById('tab-players')
  const players = online() ? store.players : []
  list.textContent = ''
  document.getElementById('tab-count').textContent = players.length ? String(players.length) : ''
  if (!players.length) {
    list.appendChild(el('p', 't2 small tab-empty', online() ? 'Nobody else is online.' : store.sessionId ? 'The player list appears once the bot is online.' : 'Start a session to see who’s online.'))
    return
  }
  for (const player of players) {
    const row = el('div', 'tab-player' + (player.me ? ' me' : '') + (player.gm === 3 ? ' spectator' : ''))
    const name = player.dn ? appendSegs(el('span', 'tab-name'), player.dn) : el('span', 'tab-name', player.name)
    name.title = player.name
    row.appendChild(name)
    if (player.ping != null) row.appendChild(el('span', 'tab-ping num', `${player.ping} ms`))
    list.appendChild(row)
  }
}

export function renderBoard () {
  renderBars(document.getElementById('play-bars'))
  renderBars(document.getElementById('server-bars'))
  renderPlayCard()
  renderServerBoard()
}

export function initBoard () {
  const all = () => {
    renderBoard()
    renderTab()
  }
  store.on('board', all)
  store.on('snapshot', all)
  store.on('sessions', all)
  store.on('session', () => {
    expanded = false
    all()
  })
  store.on('players', renderTab)
  all()
}
