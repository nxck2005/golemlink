import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Movement } from '../src/movement.js'

function fakeBot () {
  const states = {}
  return {
    states,
    entity: { yaw: 0, pitch: 0, position: { x: 0, y: 64, z: 0 } },
    setControlState (k, on) {
      states[k] = on
    },
    getControlState (k) {
      return Boolean(states[k])
    },
    clearControlStates () {
      for (const key of Object.keys(states)) states[key] = false
    },
    look () {
      return Promise.resolve()
    },
    pathfinder: null
  }
}

function makeMovement (bot, resets) {
  return new Movement({
    bot,
    deadmanMs: 600,
    logger: { warn () {} },
    onCtlReset: reason => resets.push(reason),
    onGoto: () => {}
  })
}

test('momentary controls clear after deadmanMs without holds', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
  const bot = fakeBot()
  const resets = []
  const movement = makeMovement(bot, resets)
  movement.setControl('forward', true, 'client-1')
  mock.timers.tick(100)
  assert.equal(bot.states.forward, true)
  mock.timers.tick(400)
  assert.equal(bot.states.forward, true, 'still inside the 600 ms lease')
  mock.timers.tick(300)
  assert.equal(bot.states.forward, false)
  assert.deepEqual(resets, ['deadman'])
  movement.destroy()
  mock.timers.reset()
})

test('holds extend the lease; latched controls survive a deadman', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
  const bot = fakeBot()
  const resets = []
  const movement = makeMovement(bot, resets)
  movement.setControl('sprint', true, 'client-1')
  movement.setControl('forward', true, 'client-1')
  for (let i = 0; i < 8; i++) {
    mock.timers.tick(200)
    movement.hold('client-1')
  }
  assert.equal(bot.states.forward, true)
  assert.equal(bot.states.sprint, true)
  mock.timers.tick(700)
  assert.equal(bot.states.forward, false)
  assert.equal(bot.states.sprint, true, 'latched sprint must stay on')
  assert.deepEqual(resets, ['deadman'])
  movement.destroy()
  mock.timers.reset()
})

test('a late check is skipped so queued heartbeats run first', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
  const bot = fakeBot()
  const resets = []
  const movement = makeMovement(bot, resets)
  movement.setControl('forward', true, 'client-1')
  // Simulate a long event-loop stall: the next interval fires over 200 ms late.
  movement.nextCheck = -1000
  mock.timers.tick(100)
  assert.equal(bot.states.forward, true, 'late check must be skipped')
  movement.hold('client-1')
  mock.timers.tick(100)
  assert.equal(bot.states.forward, true)
  mock.timers.tick(600)
  assert.equal(bot.states.forward, false)
  movement.destroy()
  mock.timers.reset()
})

test('clearMomentary keeps the owner and only clears momentary keys', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
  const bot = fakeBot()
  const resets = []
  const movement = makeMovement(bot, resets)
  movement.setControl('forward', true, 'a')
  movement.setControl('jump', true, 'a')
  movement.setControl('sneak', true, 'a')
  movement.clearMomentary('disconnect')
  assert.equal(bot.states.forward, false)
  assert.equal(bot.states.jump, false)
  assert.equal(bot.states.sneak, true)
  assert.equal(movement.owner, null)
  movement.owner = 'b'
  movement.lastHold = Date.now()
  movement.setControl('back', true, 'b')
  movement.releaseLease('a')
  assert.equal(bot.states.back, true, 'another client still owns forward/back')
  movement.releaseLease('b')
  assert.equal(bot.states.back, false)
  movement.destroy()
  mock.timers.reset()
})

test('goto range validation is synchronous', () => {
  const bot = fakeBot()
  const movement = makeMovement(bot, [])
  bot.pathfinder = { setGoal () {}, stop () {}, goto () { return Promise.resolve() }, setMovements () {} }
  assert.throws(() => movement.startGoto(1000, 0), /256 blocks/)
  assert.doesNotThrow(() => movement.startGoto(10, 0))
  movement.cancelGoto('test')
  movement.destroy()
})
