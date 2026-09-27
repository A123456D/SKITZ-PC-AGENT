#!/usr/bin/env node
// SKITZ PC Agent — companion service for the Pc Controller phone app.
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
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync, createReadStream, createWriteStream } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { encodeInputLine } from './input-protocol.mjs'
import { SMTC_SCRIPT, VOLUME_SCRIPT } from './system-scripts.mjs'

const VERSION = '1.7.1'
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
  if (entry.type === 'appid') {
    // Path/name comes from our own Start-Menu scan, never from the network.
    // FileProtocolHandler runs the .lnk; explorer.exe + lnk is unreliable
    // when spawned detached from a service-like context.
    return runDetached('rundll32.exe', ['url.dll,FileProtocolHandler', entry.appid])
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

// ——— Installed-app enumeration (Start Menu / Applications folder) ———
// The phone may pin any of these by exact name; launching resolves through
// this table only, so network input never reaches a shell.

let appCache = { at: 0, apps: [] }

const APP_NAME_SAFE = /^[^"\\\r\n]{1,60}$/
const APP_NAME_NOISE = /^(uninstall|readme|help|license|documentation|about|release notes)/i

/** Start-Menu shortcut scan — names stay on this machine and never reach a shell. */
function listWinApps() {
  const roots = [
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.AppData ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ]
  const out = []
  const seen = new Set()
  const visit = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) visit(path, depth + 1)
      else if (/\.(lnk|url)$/i.test(e.name)) {
        const name = e.name.replace(/\.(lnk|url)$/i, '').trim()
        if (!name || seen.has(name.toLowerCase()) || !APP_NAME_SAFE.test(name)) continue
        if (APP_NAME_NOISE.test(name)) continue
        seen.add(name.toLowerCase())
        out.push({ name, appid: path })
      }
    }
  }
  for (const root of roots) visit(root, 0)
  return out.slice(0, 400)
}

async function listUnixApps() {
  if (PLAT === 'darwin') {
    const r = await run('sh', ['-c', "ls /Applications ~/Applications 2>/dev/null | grep -i '\\.app$' | head -300"])
    if (!r.ok) return []
    return r.detail
      .split('\n')
      .map((line) => line.trim().replace(/\.app$/i, ''))
      .filter((name) => name && APP_NAME_SAFE.test(name))
      .map((name) => ({ name, appid: name }))
  }
  // Linux: .desktop launcher ids (gtk-launch understands these directly).
  const ids = await run('sh', ['-c', "ls /usr/share/applications ~/.local/share/applications 2>/dev/null | grep '\\.desktop$' | head -300"])
  if (!ids.ok) return []
  const seen = new Set()
  const out = []
  for (const id of ids.detail.split('\n')) {
    const name = id.trim().replace(/\.desktop$/i, '')
    if (!name || !APP_NAME_SAFE.test(name) || seen.has(name)) continue
    seen.add(name)
    out.push({ name, appid: name })
  }
  return out
}

async function installedApps() {
  const now = Date.now()
  if (now - appCache.at < 10 * 60_000) return appCache.apps
  const apps = PLAT === 'win32' ? listWinApps() : await listUnixApps()
  if (apps.length) appCache = { at: now, apps }
  return apps
}

/** Exact-name lookup (case-insensitive) against the enumerated table. */
async function resolveApp(name) {
  const wanted = String(name ?? '').trim()
  if (!wanted || wanted.length > 60) return null
  const apps = await installedApps()
  const hit = apps.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
  if (!hit) return null
  if (PLAT === 'win32') return { type: 'appid', appid: hit.appid }
  if (PLAT === 'darwin') return { type: 'darwin-app', name: hit.appid }
  return { type: 'desktop-id', name: hit.appid }
}

// ——— Media window title (best-effort now-playing fallback) ———

const MEDIA_WINDOW_CAP = 15

async function windowTitles() {
  if (PLAT !== 'win32') return []
  const r = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First ${MEDIA_WINDOW_CAP} ProcessName, MainWindowTitle | ConvertTo-Json -Compress`,
  ])
  if (!r.ok) return []
  try {
    const parsed = JSON.parse(r.out || r.detail)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .map((row) => ({ app: String(row?.ProcessName ?? ''), title: String(row?.MainWindowTitle ?? '') }))
      .filter((w) => w.app && w.title)
  } catch {
    return []
  }
}

function parseVolume(r) {
  try {
    const parsed = JSON.parse(r.out || '{}')
    return {
      ok: true,
      volume: Number.isFinite(parsed?.volume) ? Math.max(0, Math.min(100, Math.round(parsed.volume))) : null,
      mute: typeof parsed?.mute === 'boolean' ? parsed.mute : null,
    }
  } catch {
    return { ok: false, volume: null, mute: null, error: 'Volume read failed' }
  }
}


// ——— File transfer (phone <-> PC, fixed safe roots only) ———

const FILE_ROOTS = {
	downloads: () => join(process.env.USERPROFILE ?? homedir(), 'Downloads'),
	desktop: () => join(process.env.USERPROFILE ?? homedir(), 'Desktop'),
	documents: () => join(process.env.USERPROFILE ?? homedir(), 'Documents'),
	pictures: () => join(process.env.USERPROFILE ?? homedir(), 'Pictures'),
	music: () => join(process.env.USERPROFILE ?? homedir(), 'Music'),
	videos: () => join(process.env.USERPROFILE ?? homedir(), 'Videos'),
}

const FILE_CAP = 500 // entries per listing
const DOWNLOAD_TOKENS = new Map() // token -> { path, at }
const UPLOAD_TOKENS = new Map() // token -> { name, at }

function listFolder(key) {
	const rootFn = FILE_ROOTS[key]
	if (!rootFn) return null
	let entries
	try {
		entries = readdirSync(rootFn(), { withFileTypes: true })
	} catch {
		return []
	}
	const out = []
	for (const e of entries) {
		if (e.name.startsWith('.')) continue
		let size = 0
		if (!e.isDirectory()) {
			try {
				size = statSync(join(rootFn(), e.name)).size
			} catch {
				continue
			}
		}
		out.push({ name: e.name, dir: e.isDirectory(), size })
		if (out.length >= FILE_CAP) break
	}
	out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
	return out
}

function sweepTokens() {
	const now = Date.now()
	for (const [t, v] of DOWNLOAD_TOKENS) if (now - v.at > 90_000) DOWNLOAD_TOKENS.delete(t)
	for (const [t, v] of UPLOAD_TOKENS) if (now - v.at > 90_000) UPLOAD_TOKENS.delete(t)
}

function resolveDownload(token) {
	sweepTokens()
	const hit = DOWNLOAD_TOKENS.get(String(token ?? ''))
	if (!hit) return null
	DOWNLOAD_TOKENS.delete(String(token ?? ''))
	return hit.value
}

function uploadTarget(name) {
	const clean = String(name ?? '')
		.replace(/[^\w. ()\[\]-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 120)
	if (!clean || clean.startsWith('_')) return null
	return join(FILE_ROOTS.downloads(), clean)
}


// ——— Windows helper scripts (PowerShell, base64-encoded to dodge quoting) ———

function psEncoded(script) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]
}

function runVolume(action, pct) {
  let script = VOLUME_SCRIPT
  if (action === 'set') script += `[Vol]::Set(${pct}, -1) | ConvertTo-Json -Compress\n`
  else if (action === 'mute') script += `[Vol]::Set(-1, 1) | ConvertTo-Json -Compress\n`
  else if (action === 'unmute') script += `[Vol]::Set(-1, 0) | ConvertTo-Json -Compress\n`
  else script += `[Vol]::Get() | ConvertTo-Json -Compress\n`
  return run('powershell.exe', psEncoded(script))
}

const CLIPBOARD_CAP = 10_000

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
    if (entry) return PLAT === 'win32' ? launchWin(entry) : launchUnix(entry)
    // Not a curated tile — allow exact-name launch from the enumerated table.
    return resolveApp(arg).then((resolved) => {
      if (!resolved) return Promise.resolve({ ok: false, error: `Unknown app "${String(arg ?? '').slice(0, 40)}"` })
      if (PLAT === 'win32') return launchWin(resolved)
      if (resolved.type === 'darwin-app') return runDetached('open', ['-a', resolved.name])
      return runFirst([
        ['gtk-launch', [resolved.name]],
        ['xdg-open', [resolved.name]],
      ])
    })
  },
  apps() {
    return installedApps().then((apps) => ({ ok: true, apps, count: apps.length }))
  },
  files(arg) {
		const key = String(arg ?? 'downloads').trim().toLowerCase()
		if (!FILE_ROOTS[key]) return { ok: false, error: 'Unknown folder' }
		const entries = listFolder(key)
		return { ok: true, folder: key, files: entries, count: entries.length }
	},
	'file-token'(arg) {
		let req = {}
		try { req = JSON.parse(String(arg ?? '{}')) } catch { }
		const key = String(req.folder ?? 'downloads').toLowerCase()
		if (!FILE_ROOTS[key]) return { ok: false, error: 'Unknown folder' }
		const name = String(req.name ?? '')
		if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
			return { ok: false, error: 'Bad file name' }
		}
		const abs = join(FILE_ROOTS[key](), name)
		if (!abs.startsWith(FILE_ROOTS[key]())) return { ok: false, error: 'Bad path' }
		let size = 0
		try { size = statSync(abs).size } catch { return { ok: false, error: 'File not found' } }
		const token = randomBytes(24).toString('hex')
		DOWNLOAD_TOKENS.set(token, { value: abs, at: Date.now() })
		sweepTokens()
		return { ok: true, url: '/file?token=' + token, name, size }
	},
	'upload-token'(arg) {
		const target = uploadTarget(arg)
		if (!target) return { ok: false, error: 'Bad file name' }
		const token = randomBytes(24).toString('hex')
		UPLOAD_TOKENS.set(token, { target, at: Date.now() })
		sweepTokens()
		return { ok: true, token, name: target.split('\\').pop() }
	},

  async media() {
    let smtc = null
    if (PLAT === 'win32') {
      const viaExe = await smtcViaExe(['get'])
      if (viaExe && String(viaExe.title ?? '').trim()) {
        smtc = {
          app: String(viaExe.app ?? ''),
          title: String(viaExe.title ?? ''),
          artist: String(viaExe.artist ?? ''),
          status: String(viaExe.status ?? '').toLowerCase(),
        }
        if (Number.isFinite(viaExe.position)) smtc.position = viaExe.position
        if (Number.isFinite(viaExe.duration)) smtc.duration = viaExe.duration
        if (Number.isFinite(viaExe.rate)) smtc.rate = viaExe.rate
      }
      if (!smtc) {
        try {
          const r = await run('powershell.exe', psEncoded(SMTC_SCRIPT))
          const parsed = JSON.parse(r.out || '[]')
          const sessions = Array.isArray(parsed) ? parsed : [parsed]
          const clean = sessions
            .map((s) => ({
              app: String(s?.app ?? ''),
              title: String(s?.title ?? ''),
              artist: String(s?.artist ?? ''),
              status: String(s?.status ?? '').toLowerCase(),
            }))
            .filter((s) => s.title)
          smtc = clean.find((s) => s.status === 'playing') ?? clean[0] ?? null
        } catch {
          smtc = null
        }
      }
    }
    const windows = PLAT === 'win32' ? await windowTitles() : []
    return { ok: true, smtc, windows }
  },
  async 'media-seek'(arg) {    const v = String(arg ?? '').trim()
    if (!/^[-+]?\d{1,6}(\.\d{1,2})?$/.test(v)) return { ok: false, error: 'Seek: seconds, or +N/-N for delta' }
    const r = await smtcViaExe(['seek', v])
    if (!r) return { ok: false, error: 'Seek needs SkitzMedia.exe (SMTC helper) — not available' }
    const smtc = {
      app: String(r.app ?? ''),
      title: String(r.title ?? ''),
      artist: String(r.artist ?? ''),
      status: String(r.status ?? '').toLowerCase(),
    }
    if (Number.isFinite(r.position)) smtc.position = r.position
    if (Number.isFinite(r.duration)) smtc.duration = r.duration
    if (Number.isFinite(r.rate)) smtc.rate = r.rate
    return { ok: true, smtc }
  },
  'mirror-start'(arg) {
    if (PLAT !== 'win32') return { ok: false, error: 'Screen mirror is Windows-only' }
    if (!existsSync(MIRROR_EXE)) return { ok: false, error: 'Mirror helper missing — repack the agent' }
    let opts = {}
    try {
      opts = JSON.parse(String(arg ?? '{}')) ?? {}
    } catch {
      opts = {}
    }
    const width = Math.max(480, Math.min(1920, Math.round(Number(opts.width) || 1280)))
    const quality = Math.max(30, Math.min(85, Math.round(Number(opts.quality) || 60)))
    const fps = Math.max(2, Math.min(15, Math.round(Number(opts.fps) || 8)))
    startMirrorChild(width, quality, Math.round(1000 / fps))
    return { ok: true, width, quality, fps }
  },
  'mirror-stop'() {
    stopMirror()
    return { ok: true }
  },
  volume(arg) {
    if (arg === undefined || arg === null || arg === '') {
      return runVolume('get').then((r) => parseVolume(r))
    }
    const text = String(arg).trim()
    if (/^mute$/i.test(text)) return runVolume('mute').then((r) => parseVolume(r))
    if (/^unmute$/i.test(text)) return runVolume('unmute').then((r) => parseVolume(r))
    if (/^toggle$/i.test(text)) {
      return runVolume('get').then((cur) => {
        const v = parseVolume(cur)
        return runVolume(v.mute ? 'unmute' : 'mute').then((r) => parseVolume(r))
      })
    }
    const pct = Number(text)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, error: 'Volume: 0-100, mute, unmute, toggle' }
    return runVolume('set', Math.round(pct)).then((r) => parseVolume(r))
  },
  clipboard(arg) {
    if (arg === undefined || arg === null || arg === '') {
      if (PLAT === 'win32') {
        return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']).then((r) => {
          const text = (r.out || '').slice(0, CLIPBOARD_CAP)
          return { ok: r.ok, text: text || null }
        })
      }
      if (PLAT === 'darwin') {
        return run('pbpaste', []).then((r) => {
          const text = (r.out || '').slice(0, CLIPBOARD_CAP)
          return { ok: r.ok, text: text || null }
        })
      }
      return { ok: false, error: 'Clipboard read needs Windows or macOS' }
    }
    const text = String(arg)
    if (text.length > CLIPBOARD_CAP) return { ok: false, error: 'Clipboard text too long (10k cap)' }
    if (PLAT !== 'win32') return { ok: false, error: 'Clipboard write is Windows-only right now' }
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    return run('powershell.exe', psEncoded(
      `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))\nSet-Clipboard -Value $t`,
    )).then((r) => ({ ok: r.ok, error: r.ok ? undefined : 'Set-Clipboard failed' }))
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
const MEDIA_EXE = join(AGENT_DIR, 'SkitzMedia.exe')

// Real SMTC state (position/duration/seek) via the compiled SkitzMedia.exe
// helper (pack-windows builds it when the Windows SDK is present). Returns
// the parsed session JSON, or null when absent/failing — callers fall back.
async function smtcViaExe(argv) {
  if (PLAT !== 'win32' || !existsSync(MEDIA_EXE)) return null
  const r = await run(MEDIA_EXE, argv)
  if (!r.ok) return null
  try {
    const parsed = JSON.parse(r.out)
    return parsed && parsed.ok ? parsed : null
  } catch {
    return null
  }
}
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
    execFile(file, argv, { windowsHide: true, timeout: 8000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').slice(0, 400_000),
        detail: err ? String(stderr || err.message).slice(0, 200) : String(stdout || '').slice(0, 200),
      })
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

// ——— HTTP: /health landing + /pair QR page + REST fallback (pair/cmd) ———

let qrLibCache = null
function qrLib() {
  if (qrLibCache === null) {
    try {
      qrLibCache = readFileSync(join(AGENT_DIR, 'qrcode.min.js'), 'utf8')
    } catch {
      qrLibCache = ''
    }
  }
  return qrLibCache
}

/** Page the PC opens in a browser: scan it with the phone camera to pair. */
function pairPage() {
  const ips = lanAddresses()
  const pin = pendingPins.has(pairingPin) ? pairingPin : null
  const links = ips
    .map((ip) => `skitz://pair?host=${encodeURIComponent(ip)}&port=${PORT}${pin ? `&pin=${pin}` : ''}`)
    
  const script = qrLib()
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PC Agent — pair</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0d0e; color: #eef4f2;
         display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #101416; border: 1px solid rgba(255,255,255,.1); border-radius: 20px; padding: 30px; max-width: 460px; }
  .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
  .seed { width: 9px; height: 9px; border-radius: 3px; background: #4dd0bd; box-shadow: 0 0 9px rgba(77,208,189,.45); }
  .brand b { font-size: 1rem; } .brand span { color: #96a5a2; font-size: 1rem; }
  h1 { font-size: .68rem; letter-spacing: .18em; color: #62706d; margin: 18px 0 4px; font-weight: 600; }
  .pin { font-family: Consolas, monospace; font-size: 2.4rem; font-weight: 700; letter-spacing: .08em; }
  p { color: #96a5a2; font-size: .85rem; line-height: 1.5; margin: 10px 0; }
  .qr { background: #fff; padding: 16px; border-radius: 14px; display: inline-block; margin: 12px 0; }
  .qr svg { display: block; }
  a { color: #7ce4d4; text-decoration: none; } a:hover { text-decoration: underline; }
  code { color: #4dd0bd; }
  .alt { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.08); }
  .cap { font-size: .64rem; letter-spacing: .14em; color: #62706d; }
</style></head><body>
<div class="card">
  <div class="brand"><span class="seed"></span><b>PC</b><span>Agent</span></div>
  <h1>PAIR WITH YOUR PHONE</h1>
  ${pin ? `<div class="pin">${pin}</div>
  <p>Open the phone's camera and point it at this code — it opens
  <b>Pc Controller</b> and pairs by itself. Inside the app: Agent → Find PC also works with this PIN.</p>` : '<p>No pairing PIN is pending right now — restart the agent to pair a new phone. A phone that paired before reconnects automatically.</p>'}
  <div class="qr" id="qr"></div>
  <p class="cap">THIS PC · agent v${VERSION} · ${HOSTNAME}</p>
  <div class="alt">
    <p class="cap">OTHER NETWORKS ON THIS PC — TAP IF YOU'RE ON THE PHONE:</p>
    ${links.map((l, i) => `<p><a href="${l}">${l.replace('skitz://pair?', '')}</a></p>`).join('')}
  </div>
</div>
<script>${script}</script>
<script>
  var links = ${JSON.stringify(links)};
  var qr = qrcode(0, 'M');
  qr.addData(links[0] || 'skitz://pair');
  qr.make();
  document.getElementById('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
</script>
</body></html>`
}

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

  if (req.method === 'GET' && url.pathname === '/pair') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(pairPage())
    return
  }

  if (req.method === 'GET' && url.pathname === '/file') {
		const abs = resolveDownload(url.searchParams.get('token'))
		if (!abs) {
			res.statusCode = 403
			res.end(JSON.stringify({ ok: false, error: 'Invalid or expired token' }))
			return
		}
		let size = 0
		try {
			size = statSync(abs).size
		} catch {
			res.statusCode = 404
			res.end(JSON.stringify({ ok: false, error: 'File gone' }))
			return
		}
		res.setHeader('Content-Type', 'application/octet-stream')
		res.setHeader('Content-Length', String(size))
		const safe = basename(abs).replace(/"/g, '')
		res.setHeader('Content-Disposition', 'attachment; filename="' + safe + '"')
		createReadStream(abs).pipe(res)
		log('file download:', safe, size + 'B')
		return
	}

	if (req.method === 'POST' && url.pathname === '/upload') {
		// Bearer token (paired app) OR a one-time upload token both authorize.
		const auth = String(req.headers.authorization ?? '')
		const bearerOk = auth === 'Bearer ' + TRUSTED_TOKEN
		const minted = UPLOAD_TOKENS.get(String(url.searchParams.get('token') ?? ''))
		if (!bearerOk && !minted) {
			res.statusCode = 401
			res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
			return
		}
		const nameParam = bearerOk ? url.searchParams.get('name') : minted.name
		const target = uploadTarget(nameParam)
		if (!target) {
			res.statusCode = 400
			res.end(JSON.stringify({ ok: false, error: 'Bad file name' }))
			return
		}
		if (minted) UPLOAD_TOKENS.delete(String(url.searchParams.get('token')))
		const cap = 500 * 1024 * 1024
		let received = 0
		req.on('data', (chunk) => {
			received += chunk.length
			if (received > cap) req.destroy()
		})
		const ws = createWriteStream(target)
		req.pipe(ws)
		ws.on('finish', () => {
			res.end(JSON.stringify({ ok: true, name: target.split('\\').pop(), size: received }))
			log('upload:', target.split('\\').pop(), received + 'B')
		})
		ws.on('error', () => {
			res.statusCode = 500
			res.end(JSON.stringify({ ok: false, error: 'Write failed' }))
		})
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

// ——— Screen mirror: SkitzMirror.exe stdout (framed JPEG) → WS binary frames ———

const MIRROR_EXE = join(AGENT_DIR, 'SkitzMirror.exe')
const mirror = { child: null, clients: new Set(), buffer: Buffer.alloc(0) }

function stopMirror() {
  if (mirror.child) {
    const child = mirror.child
    mirror.child = null
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  mirror.buffer = Buffer.alloc(0)
  for (const client of [...mirror.clients]) {
    try {
      sendFrame(client, 0x1, JSON.stringify({ type: 'mirror', event: 'stop' }))
    } catch {
      /* socket went away */
    }
  }
  mirror.clients.clear()
}

function pumpMirror(data) {
  mirror.buffer = Buffer.concat([mirror.buffer, data])
  while (mirror.buffer.length >= 4) {
    const len = mirror.buffer.readUInt32LE(0)
    if (len < 2 || len > 8_000_000 || mirror.buffer.length < 4 + len) break
    const jpeg = mirror.buffer.subarray(4, 4 + len)
    mirror.buffer = mirror.buffer.subarray(4 + len)
    const targets = mirror.clients.size ? mirror.clients : [...sockets].filter((c) => c.authed)
    for (const client of targets) {
      if (client.mirrorPaused) {
        // Backpressured: keep only the NEWEST frame so the client resumes at
        // "now" instead of bursting through a stale backlog (jitter source).
        client.mirrorNext = jpeg
        continue
      }
      try {
        if (sendFrame(client, 0x2, jpeg) === false) {
          client.mirrorPaused = true
          client.mirrorNext = jpeg
        }
      } catch {
        mirror.clients.delete(client)
      }
    }
  }
  if (mirror.buffer.length > 16_000_000) mirror.buffer = Buffer.alloc(0) // corrupt stream guard
}

function startMirrorChild(width, quality, intervalMs) {
  stopMirror()
  const child = spawn(MIRROR_EXE, [String(width), String(quality), String(intervalMs)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  mirror.child = child
  child.stdout.on('data', pumpMirror)
  child.on('exit', () => {
    if (mirror.child === child) {
      mirror.child = null
      mirror.buffer = Buffer.alloc(0)
      for (const client of mirror.clients) {
        try {
          sendFrame(client, 0x1, JSON.stringify({ type: 'mirror', event: 'stop' }))
        } catch {
          /* socket went away */
        }
      }
      mirror.clients.clear()
    }
  })
  child.on('error', () => {
    if (mirror.child === child) {
      mirror.child = null
      mirror.clients.clear()
    }
  })
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
  const client = { socket, buffer: Buffer.alloc(0), authed: false, mirrorPaused: false, mirrorNext: null }
  sockets.add(client)
  socket.on('drain', () => {
    client.mirrorPaused = false
    const jpeg = client.mirrorNext
    client.mirrorNext = null
    if (jpeg) {
      try {
        if (sendFrame(client, 0x2, jpeg) === false) client.mirrorPaused = true
      } catch {
        /* socket went away */
      }
    }
  })

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
    mirror.clients.delete(client)
  })
  socket.on('error', () => {
    clearInterval(heartbeat)
    sockets.delete(client)
    mirror.clients.delete(client)
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

function sendFrame(client, opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
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
  return client.socket.write(Buffer.concat([header, payload]))
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

process.title = 'PC Agent'

httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('')
    console.log('  PC Agent is already running (port ' + PORT + ' is in use).')
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
  console.log('  PC Agent')
  console.log('  Phone: Pc Controller → Agent tab → Find PC → PIN.')
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
