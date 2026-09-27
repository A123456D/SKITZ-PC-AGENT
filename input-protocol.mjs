// Shared Wi-Fi input encoding. Phone sends KeyboardEvent.code names; the
// agent turns them into helper stdin lines. Keep this file next to agent.mjs.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const CODE_TO_VK = {
  Enter: 0x0d,
  NumpadEnter: 0x0d,
  Escape: 0x1b,
  Backspace: 0x08,
  Tab: 0x09,
  Space: 0x20,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  CapsLock: 0x14,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Minus: 0xbd,
  Equal: 0xbb,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Backslash: 0xdc,
  Semicolon: 0xba,
  Quote: 0xde,
  Backquote: 0xc0,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
  ContextMenu: 0x5d,
  PrintScreen: 0x2c,
  ScrollLock: 0x91,
  Pause: 0x13,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadMultiply: 0x6a,
  NumpadDivide: 0x6f,
  NumpadDecimal: 0x6e,
  NumLock: 0x90,
}
for (let i = 0; i < 26; i++) CODE_TO_VK[`Key${LETTERS[i]}`] = 0x41 + i
for (let i = 0; i <= 9; i++) CODE_TO_VK[`Digit${i}`] = 0x30 + i
for (let i = 0; i <= 9; i++) CODE_TO_VK[`Numpad${i}`] = 0x60 + i
for (let i = 1; i <= 12; i++) CODE_TO_VK[`F${i}`] = 0x6f + i

const CONSUMER_VK = {
  volUp: 0xaf,
  volDown: 0xae,
  mute: 0xad,
  play: 0xb3,
  next: 0xb0,
  prev: 0xb1,
  stop: 0xb2,
  search: 0xbf, // Slash — same as HID search
  skipFwd: 0x27,
  skipBack: 0x25,
  home: 0xac,
}

const CONSUMER_CODE = {
  volUp: 'AudioVolumeUp',
  volDown: 'AudioVolumeDown',
  mute: 'AudioVolumeMute',
  play: 'MediaPlayPause',
  next: 'MediaTrackNext',
  prev: 'MediaTrackPrevious',
  search: 'Slash',
  skipFwd: 'ArrowRight',
  skipBack: 'ArrowLeft',
  home: 'BrowserHome',
  brightUp: 'MonBrightnessUp',
  brightDown: 'MonBrightnessDown',
}

const BUTTON = { left: 0, right: 1, middle: 2 }

function clamp(n, lo, hi) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(lo, Math.min(hi, Math.round(x)))
}

function safeCode(code) {
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(code) ? code : null
}

/** One stdin line for SkitzInput.exe / skitz-input.py, or null if rejected. */
export function encodeInputLine(msg, plat = process.platform) {
  if (!msg || typeof msg !== 'object') return null
  const op = String(msg.op ?? msg.kind ?? '')
  if (op === 'move') {
    const dx = clamp(msg.dx, -400, 400)
    const dy = clamp(msg.dy, -400, 400)
    if (!dx && !dy) return null
    return `m ${dx} ${dy}`
  }
  if (op === 'button') {
    const btn = BUTTON[msg.button]
    if (btn === undefined) return null
    return `b ${btn} ${msg.down ? 1 : 0}`
  }
  if (op === 'scroll') {
    const dx = clamp(msg.dx, -80, 80)
    const dy = clamp(msg.dy, -80, 80)
    if (!dx && !dy) return null
    return `s ${dx} ${dy}`
  }
  if (op === 'key') {
    const code = safeCode(msg.code)
    if (!code) return null
    const down = msg.down ? 1 : 0
    if (plat === 'win32') {
      const vk = CODE_TO_VK[code]
      if (!vk) return null
      return `k ${vk} ${down}`
    }
    return `k ${code} ${down}`
  }
  if (op === 'text') {
    const text = String(msg.text ?? '')
    if (!text || text.length > 400) return null
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null
    return `t ${Buffer.from(text, 'utf8').toString('base64')}`
  }
  if (op === 'consumer') {
    const action = String(msg.action ?? '')
    if (action === 'power' || action === 'netflix' || action === 'prime' || action === 'appletv' || action === 'disney') {
      return null
    }
    const down = msg.down ? 1 : 0
    if (plat === 'win32') {
      if (action === 'brightUp' || action === 'brightDown') {
        return `n ${action === 'brightUp' ? 1 : 0}`
      }
      const vk = CONSUMER_VK[action]
      if (!vk) return null
      return `k ${vk} ${down}`
    }
    const code = CONSUMER_CODE[action]
    if (!code) return null
    return `k ${code} ${down}`
  }
  return null
}

export { CODE_TO_VK, CONSUMER_VK }
