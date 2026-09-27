#!/usr/bin/env node
// Mouse & Keys Agent — companion service for the Mouse & Keys phone app.
//
// Runs on the desktop PC. Gives the phone (same Wi-Fi) three things Bluetooth
// HID alone cannot do:
//   1. System power controls  (sleep / lock / restart / shutdown)
//   2. System status          (hostname, uptime, agent version)
//   3. (Phase 3) app launch / window switch
//
// Zero npm dependencies. Node 18+ (built for the Node 22 that ships with the dev machine).
//
//   node agent.mjs [--port 8787] [--pin 123456] [--no-ssdp]
//
// Security model:
//   - LAN only by design. First pairing requires the 6-digit PIN shown in the
//     desktop app; the phone stores a random bearer token afterwards.
//   - Commands are a fixed allow-list (no shell interpolation of input).
//   - Every command is logged here.

import { createServer } from 'node:http'
import { createSocket as createUdpSocket } from 'node:dgram'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { networkInterfaces, hostname, uptime, platform, release } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { encodeInputLine } from './input-protocol.mjs'

const VERSION = '1.4.7'
const PROTOCOL = 1
const DEFAULT_PORT = 8787
const PLAT = platform()

// ——— CLI args ———

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, pin: null, ssdp: true }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i]) || DEFAULT_PORT
    else if (a === '--pin') out.pin = String(argv[++i] ?? '')
    else if (a === '--no-ssdp') out.ssdp = false
  }
  return out
}

const args = parseArgs(process.argv)
const PORT = args.port

// ——— Persistent trust (bearer token) ———

const CONFIG_DIR = join(homedir(), '.skitz-pc-agent')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const RUNTIME_FILE = join(CONFIG_DIR, 'runtime.json')

function writeRuntime() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(
    RUNTIME_FILE,
    JSON.stringify(
      {
        pid: process.pid,
        port: PORT,
        pin: pendingPins.has(pairingPin) ? pairingPin : null,
        ips: lanAddresses(),
        version: VERSION,
      },
      null,
      2,
    ),
  )
}

function clearRuntime() {
  try {
    if (existsSync(RUNTIME_FILE)) unlinkSync(RUNTIME_FILE)
  } catch {
    /* ignore */
  }
}

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      if (typeof cfg.token === 'string' && cfg.token.length >= 32) return cfg
    }
  } catch {
    /* fall through to fresh config */
  }
  const cfg = { token: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() }
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  return cfg
}

const config = loadConfig()
const TRUSTED_TOKEN = config.token

// Fresh pairing PIN for this run (fixed PIN via --pin helps automated tests).
const pairingPin = args.pin ?? String(randomInt(0, 1_000_000)).padStart(6, '0')
const pendingPins = new Set([pairingPin]) // PINs that can still mint a token

// ——— Helpers ———

const HOSTNAME = hostname()
const BOOT = Date.now() - uptime() * 1000

function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

function systemStatus() {
  return {
    name: HOSTNAME,
    platform: `${platform()} ${release()}`,
    version: VERSION,
    protocol: PROTOCOL,
    uptimeSec: Math.floor((Date.now() - BOOT) / 1000),
  }
}

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)

// ——— App launcher allow-list ———
// Curated targets only; arbitrary paths are deliberately NOT accepted over LAN.
const LAUNCH_MAP = {
  browser: { type: 'url', target: 'https://www.google.com' },
  spotify: { type: 'app-or-web', name: 'Spotify', url: 'https://open.spotify.com' },
  netflix: { type: 'app-or-web', name: 'Netflix', url: 'https://www.netflix.com' },
  steam: { type: 'app-or-web', name: 'Steam', url: 'https://store.steampowered.com' },
  youtube: { type: 'app-or-web', name: 'YouTube', url: 'https://www.youtube.com' },
  discord: { type: 'app-or-web', name: 'Discord', url: 'https://discord.com/app' },
  files: { type: 'exe', target: 'explorer.exe' },
  settings: { type: 'url', target: 'ms-settings:' },
  crunchyroll: { type: 'app-or-web', name: 'Crunchyroll', url: 'https://www.crunchyroll.com' },
  notepad: { type: 'exe', target: 'notepad.exe' },
  taskmgr: { type: 'exe', target: 'taskmgr.exe' },
  terminal: { type: 'exe', target: 'wt.exe' },
}

function launchWinStartAppOrUrl(name, url) {
  if (!/^[A-Za-z]+$/.test(name) || !/^https:\/\/[A-Za-z0-9._~:/?#&=-]+$/.test(url) || url.includes("'")) {
    return Promise.resolve({ ok: false, error: 'Invalid app target' })
  }
  const script = [
    `$p=@(Get-StartApps|Where-Object {$_.Name -eq '${name}'})[0]`,
    `if(-not $p){$p=@(Get-StartApps|Where-Object {$_.Name -like '${name}*'})[0]}`,
    `if($p){Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$p.AppID)}else{Start-Process '${url}'}`,
  ].join(';')
  return runDetached('powershell.exe', ['-NoP', '-W', 'Hidden', '-C', script])
}

function launchWin(entry) {
  if (entry.type === 'app-or-web') {
    return launchWinStartAppOrUrl(entry.name, entry.url)
  }
  if (entry.type === 'url') {
    return runDetached('rundll32.exe', ['url.dll,FileProtocolHandler', entry.target])
  }
  return runDetached(entry.target, [])
}

function unixOpen(target) {
  return runDetached(PLAT === 'darwin' ? 'open' : 'xdg-open', [target])
}

/** First spawn that does not fail immediately (ENOENT). */
async function runFirst(candidates) {
  for (const [file, argv] of candidates) {
    const r = await runDetached(file, argv)
    if (r.ok) return r
  }
  return { ok: false, error: 'No matching app on this system' }
}

function launchUnix(entry) {
  if (entry.type === 'app-or-web') {
    if (PLAT === 'darwin') {
      return runFirst([
        ['open', ['-a', entry.name]],
        ['open', [entry.url]],
      ])
    }
    return runFirst([
      ['gtk-launch', [entry.name]],
      ['xdg-open', [entry.url]],
    ])
  }
  if (entry.type === 'url') {
    let target = entry.target
    if (target === 'ms-settings:') {
      if (PLAT === 'darwin') return unixOpen('x-apple.systempreferences:')
      return runFirst([
        ['gnome-control-center', []],
        ['systemsettings', []],
        ['systemsettings5', []],
        ['xfce4-settings-manager', []],
        ['unity-control-center', []],
      ])
    }
    if (target === 'spotify:') target = 'https://open.spotify.com'
    if (target === 'discord:') target = 'https://discord.com/app'
    if (target.startsWith('steam:')) {
      return runFirst([
        ['xdg-open', [target]],
        [PLAT === 'darwin' ? 'open' : 'xdg-open', ['https://store.steampowered.com']],
      ])
    }
    return unixOpen(target)
  }
  if (entry.target === 'explorer.exe') return unixOpen(homedir())
  if (entry.target === 'notepad.exe') {
    if (PLAT === 'darwin') return runDetached('open', ['-a', 'TextEdit'])
    return runFirst([
      ['gnome-text-editor', []],
      ['gedit', []],
      ['kate', []],
      ['mousepad', []],
      ['xed', []],
      ['leafpad', []],
    ])
  }
  if (entry.target === 'taskmgr.exe') {
    if (PLAT === 'darwin') return runDetached('open', ['-a', 'Activity Monitor'])
    return runFirst([
      ['gnome-system-monitor', []],
      ['plasma-systemmonitor', []],
      ['xfce4-taskmanager', []],
      ['lxtask', []],
      ['ksysguard', []],
    ])
  }
  if (entry.target === 'wt.exe') {
    if (PLAT === 'darwin') return runDetached('open', ['-a', 'Terminal'])
    return runFirst([
      ['x-terminal-emulator', []],
      ['kgx', []],
      ['gnome-terminal', []],
      ['konsole', []],
      ['xfce4-terminal', []],
      ['kitty', []],
      ['alacritty', []],
      ['xterm', []],
    ])
  }
  return Promise.resolve({ ok: false, error: 'Unknown app' })
}

const COMMANDS = {
  status() {
    return { ok: true, ...systemStatus() }
  },
  sleep() {
    if (PLAT === 'win32') {
      return run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)',
      ])
    }
    if (PLAT === 'darwin') return runDetached('pmset', ['sleepnow'])
    return runDetached('systemctl', ['suspend'])
  },
  lock() {
    if (PLAT === 'win32') return run('rundll32.exe', ['user32.dll,LockWorkStation'])
    if (PLAT === 'darwin') {
      return run('osascript', [
        '-e',
        'tell application "System Events" to keystroke "q" using {control down, command down}',
      ])
    }
    return run('loginctl', ['lock-session'])
  },
  restart() {
    if (PLAT === 'win32') return run('shutdown.exe', ['/r', '/t', '5'])
    return run('shutdown', ['-r', '+1'])
  },
  shutdown() {
    if (PLAT === 'win32') return run('shutdown.exe', ['/s', '/t', '5'])
    return run('shutdown', ['-h', '+1'])
  },
  cancel() {
    if (PLAT === 'win32') {
      return run('shutdown.exe', ['/a']).then((r) => {
        if (r.ok) return { ok: true, detail: 'Pending shutdown/restart cancelled' }
        if (/1116|no shutdown was in progress/i.test(r.detail))
          return { ok: true, detail: 'No pending shutdown/restart' }
        return r
      })
    }
    return run('shutdown', ['-c']).then((r) => {
      if (r.ok) return { ok: true, detail: 'Pending shutdown/restart cancelled' }
      if (/no (pending )?shutdown|cannot find/i.test(r.detail))
        return { ok: true, detail: 'No pending shutdown/restart' }
      return r
    })
  },
  launch(arg) {
    const entry = LAUNCH_MAP[String(arg ?? '')]
    if (!entry) return Promise.resolve({ ok: false, error: `Unknown app "${arg ?? ''}"` })
    return PLAT === 'win32' ? launchWin(entry) : launchUnix(entry)
  },
  start() {
    if (PLAT === 'win32') {
      return run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); }'; [K]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [K]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)",
      ])
    }
    if (PLAT === 'darwin') return runDetached('open', ['-a', 'Launchpad'])
    return unixOpen('/usr/share/applications')
  },
}

const AGENT_DIR = dirname(fileURLToPath(import.meta.url))
const INPUT_DRY = process.env.SKITZ_INPUT_DRY === '1'
let inputChild = null
let inputAccX = 0
let inputAccY = 0
let inputFlushTimer = null
let lastInputAt = 0
let inputBurst = 0

function startInputHelper() {
  if (INPUT_DRY || inputChild) return
  try {
    if (PLAT === 'win32') {
      const exe = [join(AGENT_DIR, 'SkitzInput.exe'), join(AGENT_DIR, 'dist', 'windows', 'SkitzInput.exe')].find(
        existsSync,
      )
      if (!exe) {
        log('pointer helper missing (SkitzInput.exe) — pack the Windows zip')
        return
      }
      inputChild = spawn(exe, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    } else {
      const py = existsSync(join(AGENT_DIR, 'skitz-input.py'))
        ? join(AGENT_DIR, 'skitz-input.py')
        : join(AGENT_DIR, 'linuxapp', 'skitz-input.py')
      if (!existsSync(py)) {
        log('pointer helper missing (skitz-input.py)')
        return
      }
      inputChild = spawn('python3', [py], { stdio: ['pipe', 'ignore', 'ignore'] })
    }
    inputChild.on('exit', () => {
      inputChild = null
    })
    inputChild.on('error', (e) => {
      log('pointer helper:', e.message)
      inputChild = null
    })
  } catch (e) {
    log('pointer helper:', e?.message ?? e)
  }
}

function writeInputLine(line) {
  if (!line) return
  if (INPUT_DRY) {
    process.stdout.write(`input ${line}\n`)
    return
  }
  startInputHelper()
  if (!inputChild?.stdin || inputChild.stdin.destroyed) return
  try {
    inputChild.stdin.write(line + '\n')
  } catch {
    /* helper gone */
  }
}

function flushPointer() {
  inputFlushTimer = null
  const dx = Math.round(inputAccX)
  const dy = Math.round(inputAccY)
  inputAccX -= dx
  inputAccY -= dy
  if (dx || dy) writeInputLine(encodeInputLine({ op: 'move', dx, dy }, PLAT))
}

function applyPointerInput(msg) {
  const op = String(msg.op ?? msg.kind ?? '')
  if (op === 'move') {
    const now = Date.now()
    if (now - lastInputAt > 1000) {
      lastInputAt = now
      inputBurst = 0
    }
    inputBurst += 1
    if (inputBurst > 400) return
    inputAccX += Number(msg.dx) || 0
    inputAccY += Number(msg.dy) || 0
    if (!inputFlushTimer) inputFlushTimer = setTimeout(flushPointer, 8)
    return
  }
  flushPointer()
  writeInputLine(encodeInputLine(msg, PLAT))
}

function run(file, argv) {
  return new Promise((resolve) => {
    execFile(file, argv, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, detail: err ? String(stderr || err.message).slice(0, 200) : String(stdout || '').slice(0, 200) })
    })
  })
}

// App launches must NOT wait for the app to exit (Task Manager / Terminal /
// single-instance apps never exit) — hand to the OS and report immediately.
function runDetached(file, argv) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const child = spawn(file, argv, { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', (e) => finish({ ok: false, detail: String(e.message).slice(0, 200) }))
      child.unref()
      // ENOENT arrives on the next tick; do not report success before that.
      setTimeout(() => finish({ ok: true }), 80)
    } catch (e) {
      finish({ ok: false, detail: String(e?.message ?? 'spawn failed').slice(0, 200) })
    }
  })
}

// ——— HTTP: /health landing + REST fallback (pair/cmd) ———

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://local')
  res.setHeader('Content-Type', 'application/json')
  // The phone page (vite preview / Capacitor origin) probes /health cross-origin.
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.end(JSON.stringify({ ok: true, agent: 'skitz-pc-agent', ...systemStatus() }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/pair') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 4096) req.destroy()
    })
    req.on('end', () => {
      try {
        const { pin } = JSON.parse(body)
        if (typeof pin !== 'string' || !pendingPins.has(pin)) {
          res.statusCode = 403
          res.end(JSON.stringify({ ok: false, error: 'Invalid PIN' }))
          return
        }
        pendingPins.delete(pin) // one pairing per PIN
        writeRuntime()
        res.end(JSON.stringify({ ok: true, token: TRUSTED_TOKEN, ...systemStatus() }))
        log(`paired via HTTP · PIN ${pin.slice(0, 2)}****`)
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: 'Bad JSON' }))
      }
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/cmd') {
    const auth = String(req.headers.authorization ?? '')
    if (auth !== `Bearer ${TRUSTED_TOKEN}`) {
      res.statusCode = 401
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
      return
    }
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 4096) req.destroy()
    })
    req.on('end', async () => {
      const reply = await executeCommand(body)
      res.end(JSON.stringify(reply))
    })
    return
  }

  res.statusCode = 404
  res.end(JSON.stringify({ ok: false, error: 'Not found' }))
})

let lastCommandAt = 0

async function executeCommand(body) {
  try {
    const { id, action, arg } = JSON.parse(body)
    const fn = COMMANDS[action]
    if (typeof fn !== 'function') return { id, ok: false, error: `Unknown action "${action}"` }
    // Rate-limit real executions only; unknown/rejected actions don't burn the slot.
    // `cancel` is exempt — aborting a pending shutdown must always go through.
    const now = Date.now()
    if (action !== 'cancel' && now - lastCommandAt < 250) return { id, ok: false, error: 'Too many commands' }
    lastCommandAt = now
    const result = await fn(arg)
    log(`cmd ${action}${arg ? ` ${arg}` : ''} →`, result.ok ? 'ok' : result.detail)
    return { id, ...result }
  } catch (e) {
    return { ok: false, error: e?.message ?? 'Bad request' }
  }
}

// ——— WebSocket at /ws (RFC6455, just enough for JSON control messages) ———

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const sockets = new Set()

httpServer.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://local')
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  const client = { socket, buffer: Buffer.alloc(0), authed: false }
  sockets.add(client)

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk])
    try {
      while (readFrame(client)) {
        /* drain all complete frames */
      }
    } catch {
      dropClient(client, 'protocol error')
    }
  })
  const heartbeat = setInterval(() => {
    if (Date.now() - (client.lastSeen ?? Date.now()) > 35000) dropClient(client, 'idle')
    else sendFrame(client, 0x9, 'pg')
  }, 15000)
  socket.on('close', () => {
    clearInterval(heartbeat)
    sockets.delete(client)
  })
  socket.on('error', () => {
    clearInterval(heartbeat)
    sockets.delete(client)
  })

  function dropClient(c, why) {
    try {
      sendFrame(c, 0x8, '')
    } catch {
      /* already gone */
    }
    c.socket.destroy()
    sockets.delete(c)
    log('socket dropped:', why)
  }

  // Returns true if a complete frame was consumed.
  function readFrame(c) {
    const buf = c.buffer
    if (buf.length < 2) return false
    const fin = buf[0] & 0x80
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < 4) return false
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (buf.length < 10) return false
      const big = buf.readBigUInt64BE(2)
      if (big > 65536n) throw new Error('frame too large')
      len = Number(big)
      offset = 10
    }
    if (len > 65536) throw new Error('frame too large')
    let mask = null
    if (masked) {
      if (buf.length < offset + 4) return false
      mask = buf.subarray(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + len) return false
    let payload = buf.subarray(offset, offset + len)
    if (mask) {
      payload = Buffer.from(payload)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    }
    c.buffer = buf.subarray(offset + len)
    c.lastSeen = Date.now()

    if (opcode === 0x8) throw new Error('close') // client closed
    if (opcode === 0x9) {
      sendFrame(c, 0xa, payload)
      return true
    }
    if (opcode === 0xa || opcode === 0x0 || fin !== 0x80) return true // pong/continuation: ignore
    if (opcode === 0x1) handleWsMessage(c, payload.toString('utf8'))
    return true
  }
})

function sendFrame(client, opcode, text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  client.socket.write(Buffer.concat([header, payload]))
}

function wsSend(client, obj) {
  try {
    sendFrame(client, 0x1, JSON.stringify(obj))
  } catch {
    /* socket went away */
  }
}

function handleWsMessage(client, text) {
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }
  if (msg.type === 'ping') {
    wsSend(client, { type: 'pong', t: msg.t })
    return
  }
  if (msg.type === 'hello') {
    const token = String(msg.auth ?? '')
    if (token === TRUSTED_TOKEN) {
      client.authed = true
      wsSend(client, { type: 'welcome', ...systemStatus() })
    } else {
      wsSend(client, { type: 'need-pin', hint: 'Enter the PIN shown on the PC' })
    }
    return
  }
  if (msg.type === 'pair') {
    const pin = String(msg.pin ?? '')
    if (!pendingPins.has(pin)) {
      wsSend(client, { type: 'pair-error', error: 'Wrong PIN — check the PIN on the PC' })
      return
    }
    pendingPins.delete(pin)
    writeRuntime()
    client.authed = true
    wsSend(client, { type: 'paired', token: TRUSTED_TOKEN, ...systemStatus() })
    log(`paired over WS · PIN ${pin.slice(0, 2)}****`)
    return
  }
  if (msg.type === 'cmd') {
    if (!client.authed) {
      wsSend(client, { id: msg.id, ok: false, error: 'Not paired' })
      return
    }
    // launch carries a curated app name; other commands take none.
    const payload = JSON.stringify({ type: 'cmd', id: msg.id, action: msg.action, arg: msg.arg })
    void executeCommand(payload).then((reply) => wsSend(client, reply))
    return
  }
  if (msg.type === 'input') {
    if (!client.authed) return
    applyPointerInput(msg)
  }
}

// ——— SSDP responder (so the phone's existing scan finds the agent) ———

function startSsdp() {
  const sock = createUdpSocket({ type: 'udp4', reuseAddr: true })
  const ips = lanAddresses()
  sock.on('error', (e) => log('ssdp error:', e.message))
  sock.on('message', (buf, rinfo) => {
    const text = buf.toString('utf8')
    if (!text.startsWith('M-SEARCH')) return
    const wantsAll = /ST:\s*ssdp:all/i.test(text)
    const wantsUs = /ST:\s*skitz-pc-agent/i.test(text)
    if (!wantsAll && !wantsUs) return
    const response =
      'HTTP/1.1 200 OK\r\n' +
      'CACHE-CONTROL: max-age=120\r\n' +
      'ST: skitz-pc-agent:1\r\n' +
      `USN: uuid:skitz-pc-agent:${HOSTNAME}\r\n` +
      'EXT:\r\n' +
      `SERVER: Node/${process.versions.node} UPnP/1.0 SkitzAgent/${VERSION}\r\n` +
      `LOCATION: http://${ips[0] ?? rinfo.address}:${PORT}/health\r\n` +
      `X-Skitz-Name: ${HOSTNAME}\r\n` +
      `X-Skitz-Port: ${PORT}\r\n\r\n`
    sock.send(response, rinfo.port, rinfo.address)
  })
  sock.bind(1900, () => {
    try {
      sock.addMembership('239.255.255.250')
    } catch (e) {
      log('ssdp multicast join failed:', e.message)
    }
  })
}

// ——— Boot ———

process.title = 'Mouse & Keys Agent'

httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('')
    console.log('  Mouse & Keys Agent is already running (port ' + PORT + ' is in use).')
    console.log('  Look for it in the notification area, or stop the other copy first.')
    console.log('')
    process.exit(0)
  }
  console.error(err)
  process.exit(1)
})

httpServer.listen(PORT, '0.0.0.0', () => {
  writeRuntime()
  const ips = lanAddresses()
  console.log('')
  console.log('  Mouse & Keys Agent')
  console.log('  Phone: Mouse & Keys → Agent tab → Find PC → PIN.')
  console.log('')
  log(`v${VERSION} · ${PLAT} · port ${PORT}`)
  for (const ip of ips) log(`  ${ip}`)
  if (!ips.length) log('  No LAN IP yet — connect Wi-Fi, then restart this program.')
  if (pendingPins.size) {
    console.log('')
    console.log(`  PAIRING PIN:  ${pairingPin}`)
    console.log('')
  }
  if (PLAT !== 'win32') log('unix restart/shutdown use shutdown +1 minute; Cancel aborts')
  if (args.ssdp) startSsdp()
  startInputHelper()
})

function stopInputHelper() {
  try {
    inputChild?.stdin?.end()
    inputChild?.kill()
  } catch {
    /* ignore */
  }
  inputChild = null
}

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('exit', () => {
  stopInputHelper()
  clearRuntime()
})
