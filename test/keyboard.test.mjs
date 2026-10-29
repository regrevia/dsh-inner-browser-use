import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KEYS, commandOf, keyEvent, keySpec, modifierBits, pressChord, pressKey, splitChord } from '../tools.js'

/** A page that records what it was asked to press. */
function recorder() {
  const calls = []
  return { calls, page: { key: async (type, spec) => { calls.push([type, spec]) } } }
}

test('every key a keyboard has is in the table, with the numbers a page reads', () => {
  for (let n = 1; n <= 12; n += 1) assert.equal(KEYS[`F${n}`].keyCode, 111 + n)
  assert.equal(KEYS.Insert.keyCode, 45)
  assert.equal(KEYS.ContextMenu.keyCode, 93)
  assert.equal(KEYS.NumLock.keyCode, 144)
  assert.equal(KEYS.NumpadEnter.code, 'NumpadEnter')
  assert.equal(KEYS.NumpadAdd.text, '+')
  for (const digit of '0123456789') assert.equal(KEYS[`Numpad${digit}`].keyCode, 96 + Number(digit))
  /* Both halves of every punctuation key: a page reads `?` as Slash with shift
     down, and a field inserts `?`. */
  const pairs = [['`', '~'], ['-', '_'], ['=', '+'], ['[', '{'], [']', '}'], ['\\', '|'],
    [';', ':'], ["'", '"'], [',', '<'], ['.', '>'], ['/', '?']]
  for (const [plain, shifted] of pairs) {
    assert.equal(KEYS[plain].shift, undefined)
    assert.equal(KEYS[shifted].shift, true)
    assert.equal(KEYS[plain].code, KEYS[shifted].code)
    assert.equal(KEYS[plain].text, plain)
    assert.equal(KEYS[shifted].text, shifted)
  }
  for (const symbol of '~!@#$%^&*()_+{}|:"<>?') assert.equal(KEYS[symbol].text, symbol)
})

test('a key is found by the name a person or a model would type', () => {
  assert.equal(keySpec('esc'), KEYS.Escape)
  assert.equal(keySpec('Escape'), KEYS.Escape)
  assert.equal(keySpec('escape'), KEYS.Escape)
  assert.equal(keySpec('return'), KEYS.Enter)
  assert.equal(keySpec('del'), KEYS.Delete)
  assert.equal(keySpec('up'), KEYS.ArrowUp)
  assert.equal(keySpec('f5'), KEYS.F5)
  assert.equal(keySpec('F12'), KEYS.F12)
  assert.equal(keySpec(' '), KEYS.Space)
  assert.equal(keySpec('space'), KEYS.Space)
  assert.throws(() => keySpec('NoSuchKey'), /no such key/)
})

test('a modifier is spelled the way the machine holding it spells it', () => {
  assert.equal(modifierBits('Ctrl+Shift'), 10)
  assert.equal(modifierBits('Alt'), 1)
  assert.equal(modifierBits('Option'), 1)
  assert.equal(modifierBits('Cmd'), 4)
  assert.equal(modifierBits('Command+Shift'), 12)
  assert.equal(modifierBits('Win'), 4)
  assert.equal(modifierBits('Mod', 'darwin'), 4)
  assert.equal(modifierBits('Mod', 'win32'), 2)
  assert.equal(modifierBits('Mod', 'linux'), 2)
  assert.equal(modifierBits(''), 0)
})

test('an editing shortcut is the command a browser runs, not only a key event', () => {
  const mod = 4
  assert.equal(commandOf('v', mod), 'paste')
  assert.equal(commandOf('V', mod), 'paste')
  assert.equal(commandOf('c', mod), 'copy')
  assert.equal(commandOf('x', mod), 'cut')
  assert.equal(commandOf('a', mod), 'selectAll')
  assert.equal(commandOf('z', mod), 'undo')
  assert.equal(commandOf('z', mod | 8), 'redo')
  assert.equal(commandOf('y', mod), 'redo')
  /* Either command key counts: the mirror can be driven from the other OS. */
  assert.equal(commandOf('v', 2), 'paste')
  /* A plain letter is a letter, not a command. */
  assert.equal(commandOf('v', 0), null)
  assert.equal(commandOf('v', 8), null)
  assert.equal(commandOf('ArrowDown', mod), null)
})

test('pressing a key sends its event, and a capital sends shift with it', async () => {
  const plain = recorder()
  await pressKey(plain.page, 'v', 4)
  assert.deepEqual(plain.calls, [
    ['keyDown', { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 4, text: undefined, commands: ['paste'] }],
    ['keyUp', { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 4 }],
  ])

  const capital = recorder()
  await pressKey(capital.page, 'A')
  assert.deepEqual(capital.calls[0][1], { key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 8, text: 'A' })

  const symbol = recorder()
  await pressKey(symbol.page, '+')
  assert.deepEqual(symbol.calls[0][1], { key: '+', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187, modifiers: 8, text: '+' })

  const fn = recorder()
  await pressKey(fn.page, 'F5')
  assert.deepEqual(fn.calls[0][1], { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116, nativeVirtualKeyCode: 116, modifiers: 0 })

  const held = recorder()
  await pressKey(held.page, 'ArrowDown', 0, 5)
  assert.deepEqual(held.calls.map(([type]) => type), ['keyDown', 'keyUp'])
})

test('a chord holds every key down before letting any go', async () => {
  const chord = recorder()
  await pressChord(chord.page, ['ArrowLeft', 'ArrowUp'])
  assert.deepEqual(chord.calls.map(([type, spec]) => `${type}:${spec.code}`),
    ['keyDown:ArrowLeft', 'keyDown:ArrowUp', 'keyUp:ArrowUp', 'keyUp:ArrowLeft'])
  assert.deepEqual(chord.calls.map(([, spec]) => spec.modifiers), [0, 0, 0, 0])
})

test('a chord written with its modifiers is held, not pressed as keys', () => {
  assert.deepEqual(splitChord('Ctrl+Shift+Tab'), { names: ['Tab'], modifiers: 10 })
  assert.deepEqual(splitChord('Mod+a'), { names: ['a'], modifiers: process.platform === 'darwin' ? 4 : 2 })
  assert.deepEqual(splitChord('ArrowLeft+ArrowUp', 8), { names: ['ArrowLeft', 'ArrowUp'], modifiers: 8 })
  assert.deepEqual(splitChord('Shift+4'), { names: ['4'], modifiers: 8 })
  /* A modifier on its own holds nothing to press. */
  assert.deepEqual(splitChord('Ctrl'), { names: [], modifiers: 2 })
})

test('what the mirror posts becomes the event the page sees', () => {
  /* A capital letter keeps its shift and its text. */
  assert.deepEqual(keyEvent({ key: 'A', code: 'KeyA', keyCode: 65, modifiers: 8, text: 'A' }), {
    name: 'A', down: true, repeat: false,
    spec: { key: 'A', code: 'KeyA', keyCode: 65, text: 'A', modifiers: 8 },
    command: null,
  })
  /* A shortcut becomes the browser command it names, with no text of its own. */
  assert.deepEqual(keyEvent({ key: 'v', code: 'KeyV', keyCode: 86, modifiers: 4 }), {
    name: 'v', down: true, repeat: false,
    spec: { key: 'v', code: 'KeyV', keyCode: 86, text: undefined, modifiers: 4 },
    command: 'paste',
  })
  /* A release carries no text and is no command. */
  const up = keyEvent({ key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a', down: false })
  assert.equal(up.down, false)
  assert.equal(up.command, null)
  /* A non-printing key takes its numbers from the table when the client has none. */
  assert.deepEqual(keyEvent({ key: 'Enter' }).spec, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })
  /* An auto-repeat is a keydown the page draws again, not another edit command. */
  const repeat = keyEvent({ key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a', repeat: true })
  assert.equal(repeat.repeat, true)
  assert.equal(repeat.command, null)
})
