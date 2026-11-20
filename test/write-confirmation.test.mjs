import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmationFor, createWriteGate, decideTool, isWrite } from '../bridge/policy.mjs'

test('isWrite separates changing calls from looking ones', () => {
  assert.equal(isWrite('Bash'), true)
  assert.equal(isWrite('Write'), true)
  assert.equal(isWrite('Read'), false)
  assert.equal(isWrite('Grep'), false)
  assert.equal(isWrite('mcp__jarvis__display'), false)
  assert.equal(isWrite('mcp__jarvis_eyes__look'), false)
  assert.equal(isWrite('mcp__jarvis_chrome__chrome_navigate'), false)
  assert.equal(isWrite('mcp__jarvis_chrome__chrome_click'), true)
  assert.equal(isWrite('mcp__jarvis_chrome__chrome_type'), true)
  assert.equal(isWrite('mcp__someserver__list_devices'), false)
  assert.equal(isWrite('mcp__someserver__send_email'), true)
  assert.equal(isWrite('mcp__openrouter__send-message'), false)
  assert.equal(isWrite('SomeFutureBuiltin'), true)
})

test('decideTool is exactly the negation of isWrite, unless writes are allowed', () => {
  for (const name of ['Bash', 'Read', 'mcp__jarvis_chrome__chrome_click', 'mcp__jarvis_chrome__chrome_navigate', 'mcp__x__send_mail']) {
    assert.equal(decideTool(name, false), !isWrite(name), name)
    assert.equal(decideTool(name, true), true, name)
  }
})

test('confirmationFor says what the write will do, in plain words', () => {
  assert.equal(confirmationFor('Bash', { command: 'rm -rf build' }), 'rodar o comando rm -rf build')
  assert.equal(confirmationFor('Write', { file_path: '/tmp/a/notas.md' }), 'criar ou substituir o arquivo notas.md')
  assert.equal(confirmationFor('Edit', { file_path: '/tmp/x.ts' }), 'editar o arquivo x.ts')
  assert.match(confirmationFor('mcp__jarvis_chrome__chrome_click', { ref: 'e4' }), /no seu Chrome/)
  assert.match(confirmationFor('mcp__x__send_email', { to: 'a@b' }), /^usar send email pelo serviço x com /)
})

test('confirmationFor cuts long commands so the question stays speakable', () => {
  const long = 'echo ' + 'x'.repeat(500)
  const text = confirmationFor('Bash', { command: long })
  assert.ok(text.length < 200, `too long: ${text.length}`)
  assert.ok(text.endsWith('…'))
})

test('a held write runs only after the user says confirmo, and only once', () => {
  const gate = createWriteGate()
  const input = { command: 'git push' }

  const reason = gate.check('Bash', input)
  assert.ok(reason, 'the first attempt is held')
  assert.match(reason, /Você confirma que é para eu rodar o comando git push\?/)

  assert.equal(gate.hear('confirmo'), 'confirmed')
  assert.equal(gate.check('Bash', input), null, 'the confirmed call runs')
  assert.ok(gate.check('Bash', input), 'and a second identical call is held again')
})

test('the word is exact, but case, accents and punctuation do not matter', () => {
  const answer = (words) => {
    const gate = createWriteGate()
    gate.check('Bash', { command: 'ls' })
    return gate.hear(words)
  }
  assert.equal(answer('Confirmo.'), 'confirmed')
  assert.equal(answer('confírmo!'), 'confirmed')
  assert.equal(answer('sim, confirmo'), 'declined')
  assert.equal(answer('confirma'), 'declined')
})

test('changed arguments do not borrow a confirmation', () => {
  const gate = createWriteGate()
  gate.check('Bash', { command: 'git status' })
  assert.equal(gate.hear('confirmo'), 'confirmed')
  assert.ok(gate.check('Bash', { command: 'git push --force' }), 'different command is held')
})

test('argument key order does not matter', () => {
  const gate = createWriteGate()
  gate.check('mcp__x__send_email', { to: 'a', body: 'b' })
  gate.hear('confirmo')
  assert.equal(gate.check('mcp__x__send_email', { body: 'b', to: 'a' }), null)
})

test('a different answer, or any later utterance, closes the window', () => {
  const gate = createWriteGate()
  gate.check('Bash', { command: 'ls' })
  assert.equal(gate.hear('não'), 'declined')
  assert.equal(gate.hear('confirmo'), 'none', 'nothing is pending any more')
  assert.ok(gate.check('Bash', { command: 'ls' }), 'so it is held afresh')
})

test('a confirmation does not survive the next utterance', () => {
  const gate = createWriteGate()
  gate.check('Bash', { command: 'ls' })
  gate.hear('confirmo')
  gate.hear('e agora?') // the user moved on before the model re-ran the call
  assert.ok(gate.check('Bash', { command: 'ls' }))
})

test('confirmation expires', () => {
  let clock = 0
  const gate = createWriteGate({ now: () => clock, windowMs: 1000 })
  gate.check('Bash', { command: 'ls' })
  clock = 1001
  assert.equal(gate.hear('confirmo'), 'none')
  assert.ok(gate.check('Bash', { command: 'ls' }))
})

test('confirmo with nothing pending releases nothing', () => {
  const gate = createWriteGate()
  assert.equal(gate.hear('confirmo'), 'none')
  assert.ok(gate.check('Bash', { command: 'ls' }))
})

test('two gates do not share a confirmation', () => {
  const a = createWriteGate()
  const b = createWriteGate()
  a.check('Bash', { command: 'ls' })
  b.check('Bash', { command: 'ls' })
  assert.equal(a.hear('confirmo'), 'confirmed')
  assert.ok(b.check('Bash', { command: 'ls' }), 'b was never confirmed, so it is still held')
})
