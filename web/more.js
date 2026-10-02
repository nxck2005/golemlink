import { store } from './store.js'
import { send } from './net.js'

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function field (labelText, input) {
  const label = el('label')
  label.textContent = labelText
  label.appendChild(document.createElement('br'))
  label.appendChild(input)
  return label
}

function textInput (value = '', placeholder = '') {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value ?? ''
  input.placeholder = placeholder
  input.autocapitalize = 'off'
  input.autocomplete = 'off'
  return input
}

function checkbox (checked, labelText) {
  const label = el('label')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = Boolean(checked)
  input.dataset.role = 'field'
  label.appendChild(input)
  label.appendChild(document.createTextNode(labelText))
  label.dataset.field = labelText
  return label
}

function collectCheckbox (label) {
  return label.querySelector('input').checked
}

function stateDot (state) {
  const dot = el('span', `dot ${state}`)
  return dot
}

function renderSessions () {
  const box = document.getElementById('sessions-list')
  box.textContent = ''
  if (store.sessions.length === 0) {
    box.appendChild(el('div', 'muted small', 'No sessions yet.'))
  }
  for (const session of store.sessions) {
    const card = el('div', 'card')
    const row = el('div', 'row')
    row.appendChild(stateDot(session.state))
    const info = el('div', 'grow')
    info.appendChild(el('div', 'mono', session.id))
    const reason = el('div', 'reason', session.reason ? `${session.reason}${session.detail ? ` — ${session.detail}` : ''}` : session.state)
    info.appendChild(reason)
    if (session.pendingMsa) {
      info.appendChild(el('div', 'small', `sign-in code ${session.pendingMsa.code} (${session.pendingMsa.url})`))
    }
    row.appendChild(info)
    const stop = el('button', 'btn', 'Stop')
    stop.addEventListener('click', () => send({ t: 'session.stop', s: session.id }))
    row.appendChild(stop)
    card.appendChild(row)
    box.appendChild(card)
  }
  // start row
  const card = el('div', 'card')
  const row = el('div', 'row')
  const accountSelect = document.createElement('select')
  for (const account of store.accounts) {
    const option = document.createElement('option')
    option.value = account.id
    option.textContent = account.id
    accountSelect.appendChild(option)
  }
  const serverSelect = document.createElement('select')
  for (const server of store.servers) {
    const option = document.createElement('option')
    option.value = server.id
    option.textContent = server.id
    serverSelect.appendChild(option)
  }
  const start = el('button', 'btn', 'Start')
  start.addEventListener('click', () => {
    if (!accountSelect.value || !serverSelect.value) return
    send({ t: 'session.start', account: accountSelect.value, server: serverSelect.value })
  })
  row.appendChild(accountSelect)
  row.appendChild(serverSelect)
  row.appendChild(start)
  card.appendChild(row)
  box.appendChild(card)
}

function renderPlayers () {
  const box = document.getElementById('players-list')
  box.textContent = ''
  if (store.players.length === 0) {
    box.textContent = '–'
    return
  }
  for (const player of store.players) {
    const line = el('div')
    line.textContent = `${player.name}${player.ping != null ? ` · ${player.ping} ms` : ''}${player.gm ? ` · ${player.gm}` : ''}`
    box.appendChild(line)
  }
}

function serverForm (existing) {
  const form = document.createElement('form')
  const id = textInput(existing?.id, 'main')
  const name = textInput(existing?.name, 'My server')
  const host = textInput(existing?.host, 'play.example.net')
  const port = textInput(existing?.port ?? 25565, '25565')
  const version = textInput(existing?.version ?? 'auto', 'auto')
  const autoReconnect = checkbox(existing ? existing.autoReconnect !== false : true, 'auto-reconnect')
  const chatLog = checkbox(existing ? existing.chatLog !== false : true, 'chat log')
  const antiAfkEnabled = checkbox(existing?.antiAfk?.enabled === true, 'anti-AFK')
  const antiAfkInterval = textInput(existing?.antiAfk?.intervalSec ?? 90, '90')
  const alertsDamage = checkbox(existing ? existing.alerts?.damage !== false : true, 'damage alerts')
  const alertsDeath = checkbox(existing ? existing.alerts?.death !== false : true, 'death alerts')
  const keywords = textInput((existing?.alerts?.keywords || []).join(', '), 'keyword, /regex/i')
  const resourcePack = document.createElement('select')
  for (const value of ['accept', 'deny']) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    resourcePack.appendChild(option)
  }
  resourcePack.value = existing?.resourcePack || 'accept'
  const loginTrigger = textInput('', existing?.hasAutoLogin ? 'keep current trigger' : '/(login|log in)/i')
  const password = document.createElement('input')
  password.type = 'password'
  password.placeholder = existing?.hasAutoLogin ? 'keep current password' : 'auto-login password'
  password.autocapitalize = 'off'
  password.autocomplete = 'new-password'

  form.appendChild(field('id', id))
  form.appendChild(field('name', name))
  form.appendChild(field('host', host))
  form.appendChild(field('port', port))
  form.appendChild(field('version (auto or e.g. 1.21.11)', version))
  form.appendChild(autoReconnect)
  form.appendChild(chatLog)
  form.appendChild(antiAfkEnabled)
  form.appendChild(field('anti-AFK interval seconds', antiAfkInterval))
  form.appendChild(alertsDamage)
  form.appendChild(alertsDeath)
  form.appendChild(field('alert keywords', keywords))
  form.appendChild(field('resource pack', resourcePack))
  form.appendChild(field('auto-login trigger', loginTrigger))
  form.appendChild(field('auto-login password (empty removes it)', password))

  const save = el('button', 'btn', existing ? 'Save server' : 'Add server')
  save.type = 'submit'
  form.appendChild(save)
  form.addEventListener('submit', event => {
    event.preventDefault()
    const server = {
      id: id.value.trim(),
      name: name.value.trim() || id.value.trim(),
      host: host.value.trim(),
      port: Number(port.value) || 25565,
      version: version.value.trim() || 'auto',
      autoReconnect: collectCheckbox(autoReconnect),
      chatLog: collectCheckbox(chatLog),
      antiAfk: { enabled: collectCheckbox(antiAfkEnabled), intervalSec: Number(antiAfkInterval.value) || 90 },
      alerts: {
        keywords: keywords.value.split(',').map(k => k.trim()).filter(Boolean),
        damage: collectCheckbox(alertsDamage),
        death: collectCheckbox(alertsDeath)
      },
      resourcePack: resourcePack.value
    }
    if (password.value !== '') {
      server.autoLogin = { password: password.value, trigger: loginTrigger.value.trim() || '/(login|log in)/i' }
    } else if (!existing?.hasAutoLogin && loginTrigger.value.trim()) {
      // nothing stored and no password given: don't create a half auto-login
    }
    send({ t: 'config.server.put', server })
  })
  return form
}

function renderServers () {
  const box = document.getElementById('servers-list')
  box.textContent = ''
  for (const server of store.servers) {
    const card = el('div', 'card')
    const row = el('div', 'row')
    const info = el('div', 'grow')
    info.appendChild(el('div', 'mono', `${server.id} · ${server.host}:${server.port}`))
    info.appendChild(el('div', 'small muted', `version ${server.version}${server.hasAutoLogin ? ' · auto-login' : ''}`))
    row.appendChild(info)
    const edit = el('button', 'btn', 'Edit')
    edit.addEventListener('click', () => {
      const form = serverForm(server)
      card.appendChild(form)
      edit.disabled = true
    })
    const del = el('button', 'btn', 'Delete')
    del.addEventListener('click', () => send({ t: 'config.server.del', id: server.id }))
    row.appendChild(edit)
    row.appendChild(del)
    card.appendChild(row)
    box.appendChild(card)
  }
  const add = el('button', 'btn', '+ Add server')
  add.addEventListener('click', () => {
    const form = serverForm(null)
    box.appendChild(form)
    add.disabled = true
  })
  box.appendChild(add)
}

function accountForm (existing) {
  const form = document.createElement('form')
  const id = textInput(existing?.id, 'main')
  const auth = document.createElement('select')
  for (const value of ['microsoft', 'offline']) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    auth.appendChild(option)
  }
  auth.value = existing?.auth || 'offline'
  const username = textInput(existing?.username, 'you@example.com or InGameName')
  form.appendChild(field('id', id))
  form.appendChild(field('auth', auth))
  form.appendChild(field('username', username))
  const save = el('button', 'btn', existing ? 'Save account' : 'Add account')
  save.type = 'submit'
  form.appendChild(save)
  form.addEventListener('submit', event => {
    event.preventDefault()
    send({
      t: 'config.account.put',
      account: { id: id.value.trim(), auth: auth.value, username: username.value.trim() }
    })
  })
  return form
}

function renderAccounts () {
  const box = document.getElementById('accounts-list')
  box.textContent = ''
  for (const account of store.accounts) {
    const card = el('div', 'card')
    const row = el('div', 'row')
    const info = el('div', 'grow')
    info.appendChild(el('div', 'mono', `${account.id} · ${account.auth}`))
    info.appendChild(el('div', 'small muted', account.username))
    row.appendChild(info)
    const edit = el('button', 'btn', 'Edit')
    edit.addEventListener('click', () => {
      card.appendChild(accountForm(account))
      edit.disabled = true
    })
    const del = el('button', 'btn', 'Delete')
    del.addEventListener('click', () => send({ t: 'config.account.del', id: account.id }))
    row.appendChild(edit)
    row.appendChild(del)
    card.appendChild(row)
    box.appendChild(card)
  }
  const add = el('button', 'btn', '+ Add account')
  add.addEventListener('click', () => {
    box.appendChild(accountForm(null))
    add.disabled = true
  })
  box.appendChild(add)
}

function renderDaemon () {
  const box = document.getElementById('daemon-info')
  const daemon = store.daemon
  box.textContent = ''
  if (!daemon) {
    box.textContent = '–'
    return
  }
  const lines = [
    `golemlink ${daemon.app} · Node ${daemon.node}`,
    `mineflayer ${daemon.mineflayer} · pathfinder ${daemon.pathfinder}`,
    `Minecraft versions: ${daemon.supportedRange}`,
    `event-loop p99: ${daemon.loopLagP99} ms · rss ${daemon.rssMB} MB`
  ]
  for (const line of lines) box.appendChild(el('div', '', line))
}

export function initMore () {
  store.on('sessions', renderSessions)
  store.on('accounts', renderSessions)
  store.on('servers', renderSessions)
  store.on('players', renderPlayers)
  store.on('snapshot', renderPlayers)
  store.on('accounts', renderAccounts)
  store.on('servers', renderServers)
  store.on('hello', () => {
    renderSessions()
    renderPlayers()
    renderServers()
    renderAccounts()
    renderDaemon()
  })
  renderSessions()
  renderPlayers()
  renderServers()
  renderAccounts()
  renderDaemon()
}
