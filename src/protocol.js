// Hand-written validators shared by every WebSocket handler. No dependencies,
// no schema library: the protocol is small and fixed (v1).
import { ID_RE, SESSION_ID_RE, validateServer, validateAccount } from './config.js'

export const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
export const MOMENTARY_CONTROLS = ['forward', 'back', 'left', 'right', 'jump']
export const LATCHED_CONTROLS = ['sprint', 'sneak']

export const MAX_CLIENT_FRAME = 64 * 1024
export const MAX_CHAT = 256
export const MAX_CHAT_OLD = 100
export const MAX_GOTO_DISTANCE = 256

function ok (value) {
  return { ok: true, value }
}

function fail (msg, code = 'bad_field') {
  return { ok: false, code, msg }
}

export function isSessionId (value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

export function isId (value) {
  return typeof value === 'string' && ID_RE.test(value)
}

function reqString (value, name, max = 512, min = 1) {
  if (typeof value !== 'string') return fail(`${name} must be a string`)
  if (value.length < min || value.length > max) return fail(`${name} must be ${min}-${max} characters`)
  return null
}

function optFinite (value, name) {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${name} must be a finite number`)
  return null
}

function reqFinite (value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${name} must be a finite number`)
  return null
}

function reqInt (value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) return fail(`${name} must be an integer between ${min} and ${max}`)
  return null
}

// Validate one client -> server message. `ctx` may carry UI feature flags.
export function validateClientMessage (msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return fail('message must be a JSON object', 'bad_message')
  if (typeof msg.t !== 'string') return fail('message.t must be a string', 'bad_message')
  if (msg.id !== undefined && typeof msg.id !== 'string' && typeof msg.id !== 'number') {
    return fail('message.id must be a string or number', 'bad_message')
  }
  const t = msg.t
  switch (t) {
    case 'sub':
    case 'session.stop':
    case 'hold':
    case 'stop':
    case 'interact':
    case 'use':
    case 'closeWindow': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      return ok({ t, s: msg.s })
    }
    case 'session.start': {
      if (!isId(msg.account)) return fail('account must be an id matching ^[a-z0-9_-]{1,32}$')
      if (!isId(msg.server)) return fail('server must be an id matching ^[a-z0-9_-]{1,32}$')
      return ok({ t, account: msg.account, server: msg.server })
    }
    case 'config.server.put': {
      const errors = []
      const { value } = validateServer(msg.server, { errors, prefix: 'server', partial: true })
      if (errors.length > 0) return fail(errors.join('; '))
      return ok({ t, server: value })
    }
    case 'config.server.del':
    case 'config.account.del': {
      if (!isId(msg.id)) return fail('id must match ^[a-z0-9_-]{1,32}$')
      return ok({ t, id: msg.id })
    }
    case 'config.account.put': {
      const errors = []
      const { value } = validateAccount(msg.account, { errors, prefix: 'account' })
      if (errors.length > 0) return fail(errors.join('; '))
      return ok({ t, account: value })
    }
    case 'chat': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      const err = reqString(msg.text, 'text', MAX_CHAT)
      if (err) return err
      return ok({ t, s: msg.s, text: msg.text })
    }
    case 'tab': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      const err = reqString(msg.text, 'text', MAX_CHAT, 0)
      if (err) return err
      return ok({ t, s: msg.s, text: msg.text })
    }
    case 'ctl': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      if (!CONTROLS.includes(msg.k)) return fail(`k must be one of ${CONTROLS.join(', ')}`)
      if (typeof msg.on !== 'boolean') return fail('on must be a boolean')
      return ok({ t, s: msg.s, k: msg.k, on: msg.on })
    }
    case 'look': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      const err = reqFinite(msg.yaw, 'yaw') || reqFinite(msg.pitch, 'pitch')
      if (err) return err
      return ok({ t, s: msg.s, yaw: msg.yaw, pitch: msg.pitch })
    }
    case 'lookAt': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      const err = reqFinite(msg.x, 'x') || reqFinite(msg.y, 'y') || reqFinite(msg.z, 'z')
      if (err) return err
      return ok({ t, s: msg.s, x: msg.x, y: msg.y, z: msg.z })
    }
    case 'goto': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      const err = reqFinite(msg.x, 'x') || reqFinite(msg.z, 'z') || optFinite(msg.y, 'y')
      if (err) return err
      return ok({ t, s: msg.s, x: msg.x, z: msg.z, y: msg.y })
    }
    case 'step': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      if (!['n', 'e', 's', 'w'].includes(msg.dir)) return fail('dir must be n, e, s or w')
      const err = reqInt(msg.n, 'n', 1, 16)
      if (err) return err
      return ok({ t, s: msg.s, dir: msg.dir, n: msg.n })
    }
    case 'hotbar': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      const err = reqInt(msg.i, 'i', 0, 8)
      if (err) return err
      return ok({ t, s: msg.s, i: msg.i })
    }
    case 'click': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      let err = reqInt(msg.window, 'window', 0, 255) ||
        reqInt(msg.slot, 'slot', -999, 512) ||
        reqInt(msg.button, 'button', 0, 8) ||
        reqInt(msg.mode, 'mode', 0, 6)
      if (err) return err
      if (msg.button !== 0 && msg.button !== 1) return fail('button must be 0 or 1')
      if (msg.mode !== 0 && msg.mode !== 1) return fail('mode must be 0 or 1')
      return ok({ t, s: msg.s, window: msg.window, slot: msg.slot, button: msg.button, mode: msg.mode })
    }
    case 'drop': {
      if (!isSessionId(msg.s)) return fail('s must be "<account>@<server>"')
      const err = reqInt(msg.slot, 'slot', 0, 512)
      if (err) return err
      if (typeof msg.all !== 'boolean') return fail('all must be a boolean')
      return ok({ t, s: msg.s, slot: msg.slot, all: msg.all })
    }
    default:
      return fail(`unknown message type "${t}"`, 'unknown_type')
  }
}

// Normalize any chat/kick component (string, JSON component, NBT, array) into
// { plain, translate? } using a caller-supplied component->string function.
export function normalizeComponentText (raw, componentToString) {
  if (raw === null || raw === undefined) return { plain: '' }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed)
        const result = normalizeComponentText(parsed, componentToString)
        if (result.plain) return result
      } catch {}
    }
    return { plain: raw }
  }
  if (Array.isArray(raw)) {
    const parts = raw.map(entry => normalizeComponentText(entry, componentToString).plain)
    return { plain: parts.join('') }
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return { plain: String(raw) }
  if (typeof raw !== 'object') return { plain: String(raw) }

  // Real JS chat components first: prismarine-chat resolves translations.
  if (componentToString) {
    try {
      const plain = componentToString(raw)
      if (typeof plain === 'string' && plain.length > 0) {
        return { plain, translate: typeof raw.translate === 'string' ? raw.translate : undefined }
      }
    } catch {}
  }

  // NBT typed values: { type, value } / { type: 'compound', value: {...} }.
  if (typeof raw.type === 'string') {
    if (raw.type === 'compound' && raw.value && typeof raw.value === 'object') {
      return normalizeComponentText(raw.value, componentToString)
    }
    if (raw.type === 'list' && raw.value) {
      return normalizeComponentText(raw.value, componentToString)
    }
    if ('value' in raw && (raw.value === null || typeof raw.value !== 'object')) {
      return normalizeComponentText(raw.value, componentToString)
    }
  }

  if (typeof raw.text === 'string') {
    const extra = Array.isArray(raw.extra) ? raw.extra.map(e => normalizeComponentText(e, componentToString).plain).join('') : ''
    return { plain: raw.text + extra, translate: typeof raw.translate === 'string' ? raw.translate : undefined }
  }
  if (raw.text !== undefined && raw.text !== null && typeof raw.text === 'object') {
    const text = normalizeComponentText(raw.text, componentToString).plain
    const extra = Array.isArray(raw.extra) ? raw.extra.map(e => normalizeComponentText(e, componentToString).plain).join('') : ''
    return { plain: text + extra }
  }
  if (typeof raw.translate === 'string') {
    const withParts = Array.isArray(raw.with) ? raw.with.map(e => normalizeComponentText(e, componentToString).plain) : []
    const translate = raw.translate
    return { plain: withParts.length ? `${translate} ${withParts.join(' ')}` : translate, translate }
  }
  if (raw.translate && typeof raw.translate === 'object') {
    const translate = normalizeComponentText(raw.translate, componentToString).plain
    const withParts = Array.isArray(raw.with) ? raw.with.map(e => normalizeComponentText(e, componentToString).plain) : []
    return { plain: withParts.length ? `${translate} ${withParts.join(' ')}` : translate, translate }
  }
  if (Array.isArray(raw.extra)) {
    return { plain: raw.extra.map(e => normalizeComponentText(e, componentToString).plain).join('') }
  }
  try {
    return { plain: JSON.stringify(raw) }
  } catch {
    return { plain: String(raw) }
  }
}
