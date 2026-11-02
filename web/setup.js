// Setup: sessions, servers, Minecraft accounts, and the devices signed in
// to this daemon.
import { store } from './store.js'
import { send, subscribe } from './net.js'
import { api } from './login.js'
import { el, icon, sessionName, sessionStatus, dotClass, ago } from './format.js'

const ID_PATTERN = '[a-z0-9_\\-]{1,32}'

function button (text, className = 'btn sm', onClick) {
  const node = el('button', className, text)
  node.type = 'button'
  if (onClick) node.addEventListener('click', onClick)
  return node
}

function input (value = '', { placeholder = '', type = 'text', required = false } = {}) {
  const node = el('input', 'input sm')
  node.type = type
  node.value = value ?? ''
  node.placeholder = placeholder
  node.required = required
  node.autocapitalize = 'off'
  node.autocomplete = 'off'
  node.spellcheck = false
  return node
}

function select (options, value) {
  const node = el('select', 'input sm')
  for (const [optionValue, text] of options) {
    const option = el('option', '', text)
    option.value = optionValue
    node.appendChild(option)
  }
  if (value !== undefined) node.value = value
  return node
}

let fieldCount = 0
function field (labelText, control, hint) {
  const box = el('div', 'field')
  const id = control.id || `f-${++fieldCount}`
  control.id = id
  const label = el('label', '', labelText)
  label.htmlFor = id
  box.append(label, control)
  if (hint) box.appendChild(el('span', 'hint', hint))
  return box
}

function check (checked, text) {
  const label = el('label', 'check')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = Boolean(checked)
  const mark = el('span', 'box')
  mark.appendChild(icon('check', 'icon sm'))
  label.append(box, mark, document.createTextNode(text))
  label.input = box
  return label
}

function idInput (existing) {
  const node = input(existing?.id, { placeholder: 'main', required: true })
  node.pattern = ID_PATTERN
  node.maxLength = 32
  node.title = 'Up to 32 lowercase letters, numbers, underscores or hyphens'
  node.readOnly = Boolean(existing)
  return node
}

function actions (form, saveText, onCancel) {
  const row = el('div', 'form-actions')
  const save = el('button', 'btn sm primary', saveText)
  save.type = 'submit'
  row.append(save, button('Cancel', 'btn sm quiet', () => {
    form.remove()
    onCancel?.()
  }))
  form.appendChild(row)
}

function listRow ({ lead, name, sub, buttons = [] }) {
  const row = el('div', 'list-row')
  row.appendChild(lead || el('span'))
  const text = el('div')
  text.appendChild(el('div', 'n', name))
  if (sub) text.appendChild(el('div', 's', sub))
  row.appendChild(text)
  const tools = el('div', 'row-actions')
  for (const b of buttons) tools.appendChild(b)
  row.appendChild(tools)
  return row
}

// Asks once more before deleting, inside the row.
function confirmButton (row, label, message, action) {
  const trigger = button(label, 'btn sm quiet')
  trigger.addEventListener('click', () => {
    if (row.querySelector('.confirm')) return
    const box = el('div', 'confirm')
    box.appendChild(el('span', '', message))
    box.append(
      button(label, 'btn sm danger', action),
      button('Keep', 'btn sm quiet', () => box.remove())
    )
    row.appendChild(box)
  })
  return trigger
}

function emptyLine (text) {
  return el('p', 'list-empty', text)
}

// --- sessions ----------------------------------------------------------------
function renderStartForm () {
  const box = document.getElementById('start-form')
  box.textContent = ''
  if (!store.accounts.length || !store.servers.length) {
    box.appendChild(emptyLine(!store.accounts.length && !store.servers.length
      ? 'Add a Minecraft account and a server first.'
      : !store.accounts.length ? 'Add a Minecraft account first.' : 'Add a server first.'))
    return
  }
  const form = el('form', 'form-grid')
  const account = select(store.accounts.map(a => [a.id, a.username === a.id ? a.id : `${a.id} (${a.username})`]))
  const server = select(store.servers.map(s => [s.id, s.name || s.id]))
  form.append(field('Account', account), field('Server', server))
  const row = el('div', 'form-actions')
  const start = el('button', 'btn sm primary', 'Start session')
  start.type = 'submit'
  start.disabled = !store.connected
  row.append(start, button('Cancel', 'btn sm quiet', () => box.classList.add('hidden')))
  box.append(form, row)
  const submit = event => {
    event?.preventDefault()
    if (!send({ t: 'session.start', account: account.value, server: server.value })) return
    box.classList.add('hidden')
    const id = `${account.value}@${server.value}`
    store.setSession(id)
    subscribe(id)
  }
  form.addEventListener('submit', submit)
  start.addEventListener('click', submit)
}

function renderSessions () {
  const box = document.getElementById('sessions-list')
  box.textContent = ''
  if (!store.sessions.length) {
    box.appendChild(emptyLine('No sessions yet. A session is one account on one server, and it keeps running when you close this page.'))
  }
  for (const session of store.sessions) {
    const running = session.state !== 'stopped'
    const row = el('div', 'list-row')
    const buttons = []
    if (session.id !== store.sessionId) {
      buttons.push(button('Open', 'btn sm quiet', () => {
        store.setSession(session.id)
        subscribe(session.id)
        window.dispatchEvent(new CustomEvent('golemlink-view', { detail: 'play' }))
      }))
    }
    if (running) {
      buttons.push(confirmButton(row, 'Stop', `Stop ${sessionName(session.id)}? The bot leaves the server.`, () => send({ t: 'session.stop', s: session.id })))
    } else {
      const [account, server] = session.id.split('@')
      buttons.push(button('Start', 'btn sm', () => send({ t: 'session.start', account, server })))
    }
    const filled = listRow({
      lead: el('span', dotClass(session)),
      name: sessionName(session.id),
      sub: session.pendingMsa ? `Microsoft sign-in code ${session.pendingMsa.code}` : sessionStatus(session) + (session.detail && !running ? `. ${session.detail}` : ''),
      buttons
    })
    row.append(...filled.childNodes)
    box.appendChild(row)
  }
  const form = document.getElementById('start-form')
  if (!form.classList.contains('hidden')) renderStartForm()
}

// --- servers -----------------------------------------------------------------
function serverForm (existing, onCancel) {
  const form = el('form', 'form list-edit')
  form.noValidate = false
  const id = idInput(existing)
  const name = input(existing?.name, { placeholder: 'My server' })
  const host = input(existing?.host, { placeholder: 'play.example.net', required: true })
  host.maxLength = 253
  const port = input(existing?.port ?? 25565, { type: 'number', required: true })
  port.min = 1
  port.max = 65535
  const version = input(existing?.version ?? 'auto', { placeholder: 'auto' })
  const autoReconnect = check(existing ? existing.autoReconnect !== false : true, 'Reconnect when kicked or disconnected')
  const chatLog = check(existing ? existing.chatLog !== false : true, 'Save chat to a log file')
  const antiAfk = check(existing?.antiAfk?.enabled === true, 'Anti-AFK')
  const interval = input(existing?.antiAfk?.intervalSec ?? 90, { type: 'number' })
  interval.min = 5
  interval.max = 3600
  const damage = check(existing ? existing.alerts?.damage !== false : true, 'Alert when the bot takes damage')
  const death = check(existing ? existing.alerts?.death !== false : true, 'Alert when the bot dies')
  const keywords = input((existing?.alerts?.keywords || []).join(', '), { placeholder: 'your name, /regex/i' })
  const pack = select([['accept', 'Accept'], ['deny', 'Decline']], existing?.resourcePack || 'accept')
  const trigger = input('', { placeholder: existing?.hasAutoLogin ? 'Keep the current trigger' : '/(login|log in)/i' })
  const password = input('', { type: 'password', placeholder: existing?.hasAutoLogin ? 'Keep the current password' : 'Password for /login' })
  password.autocomplete = 'new-password'
  const removeLogin = check(false, 'Remove the saved auto-login')

  const basics = el('div', 'form-grid')
  basics.append(field('ID', id), field('Name', name), field('Host', host), field('Port', port))
  form.appendChild(basics)
  const more = el('details')
  more.appendChild(el('summary', '', 'More settings'))
  const inner = el('div', 'form')
  inner.append(
    field('Minecraft version', version, 'auto, or a version like 1.21.11'),
    autoReconnect,
    chatLog,
    antiAfk,
    field('Anti-AFK interval in seconds', interval, 'Check the server’s rules before turning anti-AFK on.'),
    damage,
    death,
    field('Alert keywords', keywords, 'Comma separated. Matching chat lines send an alert and are highlighted.'),
    field('Server resource pack', pack),
    field('Auto-login trigger', trigger, 'Leave blank to keep the current one.'),
    field('Auto-login password', password, 'Sent as /login when the trigger appears in chat.')
  )
  if (existing?.hasAutoLogin) inner.appendChild(removeLogin)
  more.appendChild(inner)
  form.appendChild(more)
  actions(form, existing ? 'Save server' : 'Add server', onCancel)

  form.addEventListener('submit', event => {
    event.preventDefault()
    const server = {
      id: id.value.trim(),
      name: name.value.trim() || id.value.trim(),
      host: host.value.trim(),
      port: Number(port.value),
      version: version.value.trim() || 'auto',
      autoReconnect: autoReconnect.input.checked,
      chatLog: chatLog.input.checked,
      antiAfk: { enabled: antiAfk.input.checked, intervalSec: Number(interval.value) || 90 },
      alerts: {
        keywords: keywords.value.split(',').map(k => k.trim()).filter(Boolean),
        damage: damage.input.checked,
        death: death.input.checked
      },
      resourcePack: pack.value
    }
    if (removeLogin.input.checked) server.autoLogin = null
    else if (password.value !== '') server.autoLogin = { password: password.value, trigger: trigger.value.trim() || '/(login|log in)/i' }
    else if (existing?.hasAutoLogin && trigger.value.trim()) server.autoLogin = { trigger: trigger.value.trim() }
    send({ t: 'config.server.put', server })
  })
  return form
}

function renderServers () {
  const box = document.getElementById('servers-list')
  box.textContent = ''
  if (!store.servers.length) box.appendChild(emptyLine('No servers yet.'))
  for (const server of store.servers) {
    const row = el('div', 'list-row')
    const edit = button('Edit', 'btn sm quiet')
    edit.addEventListener('click', () => {
      edit.disabled = true
      row.appendChild(serverForm(server, () => { edit.disabled = false }))
    })
    const details = [server.host + (server.port !== 25565 ? `:${server.port}` : '')]
    if (server.version && server.version !== 'auto') details.push(server.version)
    if (server.hasAutoLogin) details.push('auto-login')
    if (server.antiAfk?.enabled) details.push('anti-AFK')
    const filled = listRow({
      lead: icon('server'),
      name: server.name || server.id,
      sub: details.join(', '),
      buttons: [edit, confirmButton(row, 'Delete', `Delete ${server.name || server.id}?`, () => send({ t: 'config.server.del', id: server.id }))]
    })
    row.append(...filled.childNodes)
    box.appendChild(row)
  }
}

// --- accounts ------------------------------------------------------------------
function accountForm (existing, onCancel) {
  const form = el('form', 'form list-edit')
  const id = idInput(existing)
  const auth = select([['microsoft', 'Microsoft'], ['offline', 'Offline (cracked servers only)']], existing?.auth || 'microsoft')
  const username = input(existing?.username, { placeholder: 'Email or in-game name', required: true })
  username.maxLength = 128
  const grid = el('div', 'form-grid')
  grid.append(field('ID', id), field('Sign-in', auth))
  form.append(grid, field('Username', username, 'Microsoft accounts sign in with a code the first time.'))
  actions(form, existing ? 'Save account' : 'Add account', onCancel)
  form.addEventListener('submit', event => {
    event.preventDefault()
    send({ t: 'config.account.put', account: { id: id.value.trim(), auth: auth.value, username: username.value.trim() } })
  })
  return form
}

function renderAccounts () {
  const box = document.getElementById('accounts-list')
  box.textContent = ''
  if (!store.accounts.length) box.appendChild(emptyLine('No accounts yet.'))
  for (const account of store.accounts) {
    const row = el('div', 'list-row')
    const edit = button('Edit', 'btn sm quiet')
    edit.addEventListener('click', () => {
      edit.disabled = true
      row.appendChild(accountForm(account, () => { edit.disabled = false }))
    })
    const avatar = el('span', `avatar${account.auth === 'microsoft' ? ' ms' : ' off'}`, (account.username || account.id).slice(0, 1))
    const filled = listRow({
      lead: avatar,
      name: account.username || account.id,
      sub: `${account.auth === 'microsoft' ? 'Microsoft' : 'Offline'}, ID ${account.id}`,
      buttons: [edit, confirmButton(row, 'Delete', `Delete ${account.id}?`, () => send({ t: 'config.account.del', id: account.id }))]
    })
    row.append(...filled.childNodes)
    box.appendChild(row)
  }
}

// --- logins ----------------------------------------------------------------------
export async function renderLogins () {
  const box = document.getElementById('logins-list')
  let logins
  try {
    logins = (await api('logins')).logins
  } catch (err) {
    if (err.status === 401) return
    box.textContent = ''
    box.appendChild(emptyLine('Couldn’t load your devices.'))
    return
  }
  box.textContent = ''
  logins.sort((a, b) => (b.current - a.current) || (b.lastUsed - a.lastUsed))
  for (const login of logins) {
    const row = el('div', 'list-row')
    const mobile = /iPhone|iPad|Android/.test(login.label)
    const sub = login.current
      ? `This device${login.ip ? `, ${login.ip}` : ''}`
      : `Last used ${ago(login.lastUsed)}${login.ip ? `, ${login.ip}` : ''}`
    const buttons = login.current
      ? []
      : [confirmButton(row, 'Sign out', `Sign out ${login.label}?`, async () => {
          try {
            await api(`logins/${login.id}`, { method: 'DELETE' })
          } catch {}
          renderLogins()
        })]
    const filled = listRow({ lead: icon(mobile ? 'phone' : 'desktop'), name: login.label, sub, buttons })
    row.append(...filled.childNodes)
    box.appendChild(row)
  }
}

function initPassword () {
  const form = document.getElementById('password-form')
  const open = document.getElementById('change-password')
  const error = document.getElementById('pw-error')
  const close = () => {
    form.classList.add('hidden')
    form.reset()
    error.textContent = ''
    open.disabled = false
  }
  open.addEventListener('click', () => {
    form.classList.remove('hidden')
    open.disabled = true
    document.getElementById('pw-current').focus()
  })
  document.getElementById('pw-cancel').addEventListener('click', close)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const current = document.getElementById('pw-current').value
    const next = document.getElementById('pw-next').value
    if (next.length < 8) {
      error.textContent = 'Use at least 8 characters for the new password'
      return
    }
    const submit = form.querySelector('button[type="submit"]')
    submit.disabled = true
    try {
      await api('password', { method: 'POST', body: { current, next } })
      close()
      window.dispatchEvent(new CustomEvent('golemlink-toast', { detail: 'Password changed. Your other devices are signed out.' }))
      renderLogins()
    } catch (err) {
      error.textContent = err.message
    } finally {
      submit.disabled = false
    }
  })
}

function renderDaemon () {
  const box = document.getElementById('daemon-info')
  const d = store.daemon
  box.textContent = d
    ? `golemlink ${d.app}, Node ${d.node}, mineflayer ${d.mineflayer}. Minecraft ${d.supportedRange}. Memory ${d.rssMB} MB.`
    : ''
}

export function renderSetup () {
  renderSessions()
  renderServers()
  renderAccounts()
  renderDaemon()
}

export function initSetup () {
  document.getElementById('new-session').addEventListener('click', () => {
    const form = document.getElementById('start-form')
    form.classList.toggle('hidden')
    if (!form.classList.contains('hidden')) {
      renderStartForm()
      form.querySelector('select')?.focus()
    }
  })
  const openForm = (listId, make, trigger) => {
    const list = document.getElementById(listId)
    if (list.querySelector(':scope > form')) return
    trigger.disabled = true
    const form = make(null, () => { trigger.disabled = false })
    list.prepend(form)
    form.querySelector('input')?.focus()
  }
  const addServer = document.getElementById('add-server')
  addServer.addEventListener('click', () => openForm('servers-list', serverForm, addServer))
  const addAccount = document.getElementById('add-account')
  addAccount.addEventListener('click', () => openForm('accounts-list', accountForm, addAccount))
  initPassword()

  store.on('sessions', renderSessions)
  store.on('session', renderSessions)
  store.on('connection', renderSessions)
  store.on('servers', () => {
    addServer.disabled = false
    renderServers()
    renderSessions()
  })
  store.on('accounts', () => {
    addAccount.disabled = false
    renderAccounts()
    renderSessions()
  })
  store.on('hello', () => {
    renderSetup()
    renderLogins()
  })
  renderSetup()
}
