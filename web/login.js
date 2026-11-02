// Sign-in screens and the small JSON API around the login cookie.

export async function api (path, { method = 'GET', body } = {}) {
  const res = await fetch(`api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  let data = null
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`)
    err.status = res.status
    err.code = data?.error
    throw err
  }
  return data
}

let onSignedIn = () => {}
let retryTimer = null

function show (which) {
  document.getElementById('auth').classList.toggle('hidden', which === null)
  document.getElementById('app').classList.toggle('hidden', which !== null)
  for (const id of ['auth-setup', 'auth-signin', 'auth-offline']) {
    document.getElementById(id).classList.toggle('hidden', id !== which)
  }
  const form = which && document.getElementById(which)
  const first = form?.querySelector('input')
  if (first && !form.contains(document.activeElement)) setTimeout(() => first.focus(), 0)
}

// Checks the cookie and shows the right screen. Resolves with the signed-in
// user, or null while a sign-in screen is up.
export async function checkLogin () {
  clearTimeout(retryTimer)
  let me
  try {
    me = await api('me')
  } catch {
    show('auth-offline')
    retryTimer = setTimeout(() => checkLogin().then(user => user && onSignedIn(user)), 4000)
    return null
  }
  if (!me.setUp) {
    show('auth-setup')
    return null
  }
  if (!me.signedIn) {
    show('auth-signin')
    return null
  }
  show(null)
  return me
}

async function submit (form, errorBox, path, body) {
  const button = form.querySelector('button[type="submit"]')
  errorBox.textContent = ''
  button.disabled = true
  try {
    await api(path, { method: 'POST', body })
    const me = await checkLogin()
    if (me) onSignedIn(me)
  } catch (err) {
    errorBox.textContent = err.message
  } finally {
    button.disabled = false
  }
}

export function initLogin (signedIn) {
  onSignedIn = signedIn
  const setup = document.getElementById('auth-setup')
  const code = document.getElementById('setup-code')
  code.addEventListener('input', () => {
    const digits = code.value.replace(/\D/g, '').slice(0, 6)
    code.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits
  })
  setup.addEventListener('submit', event => {
    event.preventDefault()
    const error = document.getElementById('setup-error')
    const username = document.getElementById('setup-username').value.trim()
    const password = document.getElementById('setup-password').value
    if (code.value.replace(/\D/g, '').length !== 6) {
      error.textContent = 'Enter the 6-digit setup code from the golemlink terminal'
      return
    }
    if (!username) {
      error.textContent = 'Choose a username'
      return
    }
    if (password.length < 8) {
      error.textContent = 'Use at least 8 characters for the password'
      return
    }
    submit(setup, error, 'setup', { code: code.value.replace(/\D/g, ''), username, password, remember: true })
  })

  const signin = document.getElementById('auth-signin')
  signin.addEventListener('submit', event => {
    event.preventDefault()
    const error = document.getElementById('signin-error')
    const username = document.getElementById('signin-username').value.trim()
    const password = document.getElementById('signin-password').value
    if (!username || !password) {
      error.textContent = 'Enter your username and password'
      return
    }
    submit(signin, error, 'login', {
      username,
      password,
      remember: document.getElementById('signin-remember').checked
    }).then(() => {
      document.getElementById('signin-password').value = ''
    })
  })
}

export async function signOut () {
  try {
    await api('logout', { method: 'POST', body: {} })
  } catch {}
  await checkLogin()
}
