import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band, Card, Counts, DeckRow, Menu, Seg } from '../types'

// The sidecar (sidecar/, Rust over Anki's own core) owns the collection and
// talks to AnkiWeb. This module only draws the band and runs the sidecar, one
// call at a time: it holds an exclusive lock on the collection while it runs.

// Anki's own grade keys. Show shares 1 with again, so a grade on the show key
// within GRADE_DELAY_MS of showing is taken as a double tap and ignored.
const SHOW_KEY = '1'
const GRADES = [
  { name: 'again', key: '1' },
  { name: 'hard', key: '2' },
  { name: 'good', key: '3' },
  { name: 'easy', key: '4' },
] as const
const UNDO_KEY = '5'
const DECKS_KEY = '0'
const MORE_KEY = '9'
const GRADE_DELAY_MS = 400

type Grade = (typeof GRADES)[number]
const MAX_ANSWER_MS = 60_000
const SYNC_EVERY_MS = 10 * 60_000
const SYNC_TIMEOUT_MS = 120_000
const CALL_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 180_000
const ANKIWEB = 'https://sync.ankiweb.net/'

const card = atom({ plugin: 'anki', key: 'card' } as const, null)
const isRevealed = atom({ plugin: 'anki', key: 'isRevealed' } as const, false)
const band = atom({ plugin: 'anki', key: 'band' } as const, { status: 'idle', deck: '' })
const counts = atom({ plugin: 'anki', key: 'counts' } as const, null)
const menu = atom({ plugin: 'anki', key: 'menu' } as const, { isOpen: false, page: 0, decks: [] })
const undoable = atom({ plugin: 'anki', key: 'undoable' } as const, null)

type Settings = {
  syncServer: string
}

export type Reply = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string }

// A grade is held back until the next one, a sync or a deck change, so that
// undo only has to forget it: nothing is written to Anki and then reversed.
type Pending = { card: Card; grade: Grade; ms: number; at: number }

// Blank means AnkiWeb, as the setting's description says.
let settings: Settings = {
  syncServer: '',
}
let calls: Promise<unknown> = Promise.resolve()
let binPath: string | null = null
let dealing: Promise<void> | null = null
let pending: Pending | null = null
/** The deck being reviewed: undefined until read from the store, null when none is picked. */
let deckChoice: string | null | undefined
let shownAt = 0
let revealedAt = 0
let lastSyncAt = 0
let unsynced = 0
let isSyncing = false
/** Set while the outside login window is open, so its result is announced once it lands. */
let isAwaitingLogin = false

export function tally(c: Counts): string {
  return [c.new && `${c.new} new`, c.learning && `${c.learning} learn`, c.review && `${c.review} due`]
    .filter(Boolean)
    .join(' · ')
}

// The last line of stdout is the sidecar's one JSON reply; anything else
// (a crash, a missing binary) is folded into the same shape.
export function parseReply(stdout: string, stderr: string): Reply {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const reply = JSON.parse(line)
    if (typeof reply === 'object' && reply !== null && typeof reply.ok === 'boolean') return reply
  } catch {}

  return { ok: false, code: 'crash', message: (stderr || stdout).trim().slice(0, 300) || 'no output' }
}

// AnkiWeb's own address means "no custom server", as the official clients
// treat it, so redirects to the account's shard work as they do there.
export function syncEndpoint(url: string): string | undefined {
  const value = url.trim()
  if (!value || value.replace(/\/+$/, '') === ANKIWEB.replace(/\/+$/, '')) return undefined

  return value
}

/**
 * Pieces of a run that can wrap apart: each CJK character on its own, other
 * text by word with its trailing space.
 */
export function wrapChunks(text: string): string[] {
  return text.match(/[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]|[^\s\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]+\s*|\s+/g) ?? []
}

/** The rows on `page` of the deck menu, at most `size`, and how many pages there are. */
export function menuPage(decks: readonly DeckRow[], page: number, size: number): { rows: DeckRow[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(decks.length / size))
  const at = ((page % pages) + pages) % pages

  return { rows: decks.slice(at * size, at * size + size), page: at, pages }
}

async function run($: EngineInterface, argv: string[], timeoutMs: number, stdin?: string): Promise<Reply> {
  try {
    const { stdout, stderr } = await $.process.run(argv, { stdin, timeoutMs })
    return parseReply(stdout, stderr)
  } catch (err) {
    const message = String(err)
    const missing = /ENOENT|not found|no such file|cannot start/i.test(message)
    return { ok: false, code: missing ? 'missing' : 'crash', message }
  }
}

// Whatever the install script leaves in helper/ (not bin/, which Claude Code
// puts on Claude's own PATH): a local build, or the release
// sidecar.lock pins, downloaded and checked.
async function locate($: EngineInterface): Promise<Reply> {
  const root = $.plugin.root
  const isWindows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  const argv = isWindows
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${root}\\scripts\\install-sidecar.ps1`]
    : ['sh', `${root}/scripts/install-sidecar.sh`]

  return run($, argv, INSTALL_TIMEOUT_MS)
}

function sidecar($: EngineInterface, args: string[], init: { stdin?: string; timeoutMs?: number } = {}): Promise<Reply> {
  const call = calls.then(async (): Promise<Reply> => {
    if (binPath === null) {
      const found = await locate($)
      if (!found.ok) return found
      binPath = String(found.path)
    }
    return run($, [binPath, ...args], init.timeoutMs ?? CALL_TIMEOUT_MS, init.stdin)
  })
  calls = call.catch(() => undefined)

  return call
}

async function chosenDeck($: EngineInterface): Promise<string | null> {
  if (deckChoice === undefined) {
    const stored = await $.store.get('deck').catch(() => undefined)
    deckChoice = typeof stored === 'string' && stored !== '' ? stored : null
  }

  return deckChoice
}

async function setBand($: EngineInterface, next: Band): Promise<void> {
  await update($, band, (): Band => next)
}

async function failed($: EngineInterface, reply: Extract<Reply, { ok: false }>): Promise<void> {
  // Another session holds the collection for a moment; try again next turn.
  if (reply.code === 'busy') return
  const status: Band['status'] =
    reply.code === 'logged_out' || reply.code === 'auth' ? 'logged_out'
    : reply.code === 'desktop_open' ? 'desktop_open'
    : ['missing', 'unsupported', 'checksum'].includes(reply.code) ? 'missing'
    : 'error'
  await setBand($, { status, deck: deckChoice ?? '', message: reply.message })
  await update($, card, () => null)
}

async function openMenu($: EngineInterface): Promise<void> {
  const reply = await sidecar($, ['decks'])
  if (!reply.ok) return failed($, reply)
  await update($, menu, (): Menu => ({ isOpen: true, page: 0, decks: reply.decks as DeckRow[] }))
}

async function closeMenu($: EngineInterface): Promise<void> {
  await update($, menu, m => ({ ...m, isOpen: false }))
}

async function pickDeck($: EngineInterface, name: string): Promise<void> {
  // A held grade belongs to the old deck; settle it before switching.
  await commit($)
  deckChoice = name
  await $.store.set('deck', name).catch(() => undefined)
  await closeMenu($)
  await update($, card, () => null)
  await dealNext($)
}

async function deal($: EngineInterface): Promise<void> {
  const deck = await chosenDeck($)
  if (deck === null) return openMenu($)

  const args = ['next', '--deck', deck]
  if (pending) args.push('--skip', String(pending.card.id))
  const reply = await sidecar($, args)
  if (!reply.ok) {
    // Renamed or deleted on another device: ask again.
    if (reply.code === 'no_deck') {
      deckChoice = null
      await $.store.delete('deck').catch(() => undefined)
      return openMenu($)
    }
    return failed($, reply)
  }

  const next = reply.card as Card | null
  await update($, counts, (): Counts => reply.counts as Counts)
  await setBand($, { status: next ? 'ready' : 'empty', deck: String(reply.deck ?? deck) })
  await update($, isRevealed, () => false)
  await update($, card, current => current ?? next)
  shownAt = await $.clock.now()
}

function dealNext($: EngineInterface): Promise<void> {
  dealing ??= deal($).finally(() => {
    dealing = null
  })

  return dealing
}

/** Writes the held grade to Anki; after this it can't be undone. */
async function commit($: EngineInterface): Promise<void> {
  const held = pending
  if (held === null) return
  pending = null
  await update($, undoable, () => null)

  const reply = await sidecar($, [
    'answer', '--card', String(held.card.id), '--rating', held.grade.name,
    '--ms', String(held.ms), '--at', String(held.at),
  ])
  if (!reply.ok) return failed($, reply)
  unsynced++
}

/** What AnkiWeb sent with a sync, as a sentence to append; '' when nothing. */
export function ankiwebSays(reply: Reply): string {
  const message = reply.ok ? String(reply.serverMessage ?? '').trim() : ''
  return message ? ` AnkiWeb says: ${message}` : ''
}

const ONE_WAY_SYNC = 'AnkiWeb needs a one-way sync: /anki download (take AnkiWeb\'s copy) or /anki upload (replace it with this one).'

// A sync's own errors are AnkiWeb's (or the network's): never left unsaid.
const ANKIWEB_ERRORS = ['auth', 'sync', 'network']

/**
 * Syncs with AnkiWeb. Unless `announce` is off (a command that reports the
 * outcome itself), what AnkiWeb says and any sync error go up as a toast.
 */
async function sync(
  $: EngineInterface,
  mode: '' | '--full-download' | '--full-upload' = '',
  { announce = true }: { announce?: boolean } = {},
): Promise<Reply> {
  await commit($)
  // Logged out, keep saying so until a sync proves otherwise.
  const { status } = await read($, band)
  if ((await read($, card)) === null && status !== 'logged_out') await setBand($, { status: 'syncing', deck: deckChoice ?? '' })
  isSyncing = true
  const reply = await sidecar($, mode ? ['sync', mode] : ['sync'], { timeoutMs: SYNC_TIMEOUT_MS }).finally(() => {
    isSyncing = false
  })
  if (reply.ok) {
    lastSyncAt = await $.clock.now()
    unsynced = 0
    if (isAwaitingLogin && reply.result !== 'local') {
      // The login window finished, and this is the first sync since.
      isAwaitingLogin = false
      $.ui.toast(`Logged in to AnkiWeb and synced.${ankiwebSays(reply)}`, { timeoutMs: 10_000 })
    } else if (announce && ankiwebSays(reply)) {
      $.ui.toast(ankiwebSays(reply).trim(), { timeoutMs: 15_000 })
    }
    if (announce && reply.result === 'full_sync_required') $.ui.toast(ONE_WAY_SYNC, { timeoutMs: 10_000 })
  } else if (reply.code !== 'busy') {
    if (announce && ANKIWEB_ERRORS.includes(reply.code)) $.ui.toast(`AnkiWeb sync failed: ${reply.message}`, { timeoutMs: 15_000 })
    await failed($, reply)
  }
  // The queue may have changed under us: reviews from the phone, new cards.
  if ((await read($, card)) === null || (reply.ok && reply.result === 'downloaded')) {
    await update($, card, () => null)
    await dealNext($)
  }

  return reply
}

async function reveal($: EngineInterface): Promise<void> {
  revealedAt = await $.clock.now()
  await update($, isRevealed, () => true)
}

async function answer($: EngineInterface, shown: Card, grade: Grade): Promise<void> {
  const now = await $.clock.now()
  if (grade.key === SHOW_KEY && now - revealedAt < GRADE_DELAY_MS) return

  let isClaimed = false
  await update($, card, c => {
    isClaimed = c?.id === shown.id
    return isClaimed ? null : c
  })
  if (!isClaimed) return

  // Only one grade is held: the one before this becomes final now.
  await commit($)
  pending = { card: shown, grade, ms: Math.max(0, Math.min(now - shownAt, MAX_ANSWER_MS)), at: now }
  await update($, undoable, () => shown)
  await dealNext($)
}

async function undo($: EngineInterface): Promise<void> {
  const held = pending
  if (held === null) return
  pending = null
  await update($, undoable, () => null)
  await update($, isRevealed, () => false)
  await update($, card, () => held.card)
  shownAt = await $.clock.now()
}

/** Quotes `text` as one word for sh. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Quotes `text` as an AppleScript string. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** What the terminal Claude Code runs in says about itself, through the environment. */
export type Host = {
  platform: 'darwin' | 'linux' | 'windows'
  env: Partial<Record<
    'TMUX' | 'ZELLIJ' | 'TERM_PROGRAM' | 'KITTY_WINDOW_ID' | 'WEZTERM_PANE' | 'ALACRITTY_SOCKET' | 'WT_SESSION',
    string
  >>
}

// Runs a GUI program in the background, so the call returns once it starts.
function detached(argv: string[]): string[] {
  return ['sh', '-c', 'command -v "$1" >/dev/null || exit 1; ("$@" >/dev/null 2>&1 &)', 'sh', ...argv]
}

/**
 * The ways to open the login, best first: a new tab or window of the terminal
 * Claude Code runs in, then the platform's own terminal. `command` is the login
 * as one sh command line; `argv` the same as words, for Windows.
 */
export function launchers(host: Host, command: string, argv: string[]): string[][] {
  const { env, platform } = host
  const sh = ['sh', '-c', command]
  const out: string[][] = []
  const terminalApp = [
    'osascript', '-e', `tell application "Terminal" to do script ${appleScriptString(command)}`,
    '-e', 'tell application "Terminal" to activate',
  ]

  // A multiplexer first: it's where the person is looking, even over SSH.
  if (env.TMUX) out.push(['tmux', 'new-window', '-n', 'anki login', command])
  if (env.ZELLIJ) out.push(['zellij', 'run', '--floating', '--close-on-exit', '--name', 'anki login', '--', ...sh])

  if (env.TERM_PROGRAM === 'Apple_Terminal') out.push(terminalApp)
  if (env.TERM_PROGRAM === 'iTerm.app') {
    out.push([
      'osascript',
      '-e', 'tell application "iTerm2" to tell current window to create tab with default profile',
      '-e', `tell application "iTerm2" to tell current session of current window to write text ${appleScriptString(command)}`,
    ])
  }
  if (env.TERM_PROGRAM === 'WezTerm' || env.WEZTERM_PANE) out.push(['wezterm', 'cli', 'spawn', '--', ...sh])
  if (env.TERM_PROGRAM === 'ghostty') {
    out.push(platform === 'darwin' ? ['open', '-na', 'Ghostty.app', '--args', '-e', ...sh] : detached(['ghostty', '-e', ...sh]))
  }
  if (env.KITTY_WINDOW_ID) {
    out.push(['kitty', '@', 'launch', '--type=tab', '--title', 'anki login', ...sh])
    out.push(platform === 'darwin' ? ['open', '-na', 'kitty.app', '--args', ...sh] : detached(['kitty', ...sh]))
  }
  if (env.ALACRITTY_SOCKET) {
    out.push(['alacritty', 'msg', 'create-window', '-T', 'anki login', '-e', ...sh])
    out.push(platform === 'darwin' ? ['open', '-na', 'Alacritty.app', '--args', '-e', ...sh] : detached(['alacritty', '-e', ...sh]))
  }
  if (platform === 'windows' && env.WT_SESSION) out.push(['wt', '-w', '0', 'new-tab', '--title', 'anki login', '--', ...argv])

  // The platform's own, for a terminal we don't know (an editor's, say).
  if (platform === 'darwin') out.push(terminalApp)
  if (platform === 'windows') {
    const [file = '', ...args] = argv
    const list = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',')
    out.push(['powershell', '-NoProfile', '-Command', `Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList ${list}`])
  }
  if (platform === 'linux') {
    out.push(['sh', '-c', [
      '[ -n "$DISPLAY$WAYLAND_DISPLAY" ] || exit 1',
      'for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do',
      '  command -v "$t" >/dev/null || continue',
      '  if [ "$t" = gnome-terminal ]; then set -- "$t" --; else set -- "$t" -e; fi',
      '  (setsid "$@" sh -c "$0" >/dev/null 2>&1 &); exit 0',
      'done; exit 1',
    ].join('\n'), command])
  }

  return out
}

async function detectHost($: EngineInterface): Promise<Host> {
  const get = (p: Promise<string | undefined>) => p.catch(() => undefined)
  const isWindows = (await get($.env.get('OS'))) === 'Windows_NT'
  const uname = isWindows ? undefined : await $.process.run(['uname', '-s'], { timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined)
  const env: Host['env'] = {
    TMUX: await get($.env.get('TMUX')),
    ZELLIJ: await get($.env.get('ZELLIJ')),
    TERM_PROGRAM: await get($.env.get('TERM_PROGRAM')),
    KITTY_WINDOW_ID: await get($.env.get('KITTY_WINDOW_ID')),
    WEZTERM_PANE: await get($.env.get('WEZTERM_PANE')),
    ALACRITTY_SOCKET: await get($.env.get('ALACRITTY_SOCKET')),
    WT_SESSION: await get($.env.get('WT_SESSION')),
  }

  return { platform: isWindows ? 'windows' : uname?.stdout.trim() === 'Darwin' ? 'darwin' : 'linux', env }
}

// The login happens in a terminal window of its own, so the password goes
// from the keyboard to the sidecar and AnkiWeb, and never through Claude Code:
// not its settings, this module, other mods' hooks or the transcript.
async function openLoginWindow($: EngineInterface): Promise<string> {
  const found = await sidecar($, ['status'])
  if (!found.ok || binPath === null) return `anki couldn't start its helper: ${found.ok ? 'not installed' : found.message}`

  const endpoint = syncEndpoint(settings.syncServer)
  const argv = [binPath, 'login', '--interactive', ...(endpoint ? ['--endpoint', endpoint] : [])]
  const dir = await $.env.get('ANKI_CLAUDE_MOD_DIR').catch(() => undefined)
  const command = [dir ? `ANKI_CLAUDE_MOD_DIR=${shellQuote(dir)}` : '', ...argv.map(shellQuote)].filter(Boolean).join(' ')

  for (const launcher of launchers(await detectHost($), command, argv)) {
    const r = await $.process.run(launcher, { timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined)
    if (r?.exitCode === 0) {
      isAwaitingLogin = true
      return 'Opened a window to log in to AnkiWeb for syncing: log in there once, and your cards show up on your next prompt.'
    }
  }

  // No window we can open (SSH, no desktop): hand over the command instead.
  isAwaitingLogin = true
  for (const copy of [['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard'], ['clip']]) {
    const r = await $.process.run(copy, { stdin: command, timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined)
    if (r?.exitCode === 0) return `Couldn't open a terminal, so the login command is on your clipboard: paste it into any terminal.`
  }
  return `Run this in any terminal to log in: ${command}`
}

async function login($: EngineInterface): Promise<string> {
  // Anki desktop on this computer may already be logged in: its sync key
  // works here too, and then no password is asked for at all.
  const found = await sidecar($, ['desktop-logins'])
  const logins = found.ok ? (found.logins as { profile: string; username: string }[]).slice(0, 3) : []
  if (logins.length > 0) {
    const labels = logins.map(l => `Sync as ${l.username || 'its account'}${logins.length > 1 ? ` (profile ${l.profile})` : ''}`)
    const choice = await $.ui
      .ask('Anki desktop on this computer is logged in to AnkiWeb. Sync using its login?', [...labels, 'Log in to AnkiWeb with my password'])
      .catch(() => undefined)
    if (choice === undefined) return 'Login cancelled.'
    const picked = logins[labels.indexOf(choice)]
    if (picked) {
      const reply = await sidecar($, ['login', '--from-desktop', picked.profile])
      if (!reply.ok) return `Couldn't reuse Anki desktop's login: ${reply.message}`
      const synced = await sync($, '', { announce: false })
      if (!synced.ok) return `Logged in; sync failed: ${synced.message}`
      return `Logged in to AnkiWeb as ${String(reply.username)} with Anki desktop's sync key, and synced.${ankiwebSays(synced)}`
    }
    // They chose the password, so the window needs no second question.
    return openLoginWindow($)
  }

  const go = await $.ui
    .ask(
      'To sign in to AnkiWeb, anki opens a terminal window outside Claude Code. Your password goes only to AnkiWeb and is never saved; anki keeps just the sync key AnkiWeb gives back. Open it?',
      ['Open the login window', 'Cancel'],
    )
    .catch(() => undefined)
  if (go !== 'Open the login window') return 'Login cancelled.'

  return openLoginWindow($)
}

const NOTHING_SET_UP = 'To start: /anki login to pull decks from AnkiWeb (recommended), or /anki setup for decks on this computer.'
const NO_ANKIWEB_LOGIN = 'No AnkiWeb login yet: run /anki login to sync with AnkiWeb.'

// Reviews go straight into a collection on this computer, usually Anki
// desktop's, with no AnkiWeb: for decks that aren't synced anywhere.
async function setup($: EngineInterface, path: string): Promise<string> {
  let target = path
  if (!target) {
    const found = await sidecar($, ['local-collections'])
    const collections = found.ok ? (found.collections as { profile: string; path: string }[]).slice(0, 3) : []
    if (collections.length === 0) {
      return 'No Anki desktop collection found here. Run /anki setup <folder>, with the folder that holds your collection.anki2.'
    }
    const labels = collections.map(c => `Anki desktop: ${c.profile}`)
    const choice = await $.ui
      .ask('Which collection should anki review? You can also type the path to a folder with a collection.anki2.', labels)
      .catch(() => undefined)
    if (choice === undefined) return 'Setup cancelled.'
    target = collections[labels.indexOf(choice)]?.path ?? choice
  }

  // A held grade belongs to the collection being left.
  await commit($)
  const reply = await sidecar($, ['setup', '--collection', target])
  if (!reply.ok) return `Couldn't use that collection: ${reply.message}`
  await update($, card, () => null)
  await setBand($, { status: 'idle', deck: deckChoice ?? '' })
  if (!(await read($, menu)).isOpen) void dealNext($)

  const where = String(reply.collection)
  if (reply.ankiwebActive) {
    return `Saved ${where}, but you're logged in to AnkiWeb, which comes first: anki keeps using AnkiWeb's decks, and uses this collection only after /anki logout.`
  }
  return `Reviewing decks from ${where}. anki pauses while Anki desktop is open.`
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [sub = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  switch (sub) {
    case 'login':
      return login($)
    case 'setup':
      return setup($, rest.join(' '))
    case 'logout': {
      await commit($)
      await sidecar($, ['logout'])
      await update($, card, () => null)
      await setBand($, { status: 'logged_out', deck: deckChoice ?? '' })
      return 'Logged out of AnkiWeb. The synced copy stays here until you log in as someone else.'
    }
    case 'sync':
    case 'download':
    case 'upload': {
      const mode = sub === 'download' ? '--full-download' : sub === 'upload' ? '--full-upload' : ''
      const reply = await sync($, mode, { announce: false })
      if (reply.ok && reply.result === 'local') return 'Using local decks, which don\'t sync with AnkiWeb. /anki login to sync with AnkiWeb instead.'
      if (!reply.ok && reply.code === 'logged_out') return NO_ANKIWEB_LOGIN
      if (reply.ok && reply.result === 'full_sync_required') return `${ONE_WAY_SYNC}${ankiwebSays(reply)}`
      return reply.ok ? `AnkiWeb: ${String(reply.result).replace(/_/g, ' ')}.${ankiwebSays(reply)}` : `AnkiWeb sync failed: ${reply.message}`
    }
    case 'deck': {
      const name = rest.join(' ')
      if (name) {
        await pickDeck($, name)
        return `Reviewing ${name}.`
      }
      await openMenu($)
      return 'The deck list shows above the prompt next time Claude is working. 0 opens it any time.'
    }
    case 'status': {
      // The band only says something went wrong; this is where it says what.
      const { status, message } = await read($, band)
      const problem = (status === 'error' || status === 'missing') && message ? ` Last problem: ${message}` : ''
      const reply = await sidecar($, ['status'])
      if (!reply.ok) return `anki couldn't start its helper: ${reply.message}`
      const c = await read($, counts)
      const deck = `deck ${(await chosenDeck($)) ?? 'not picked'}${c ? ` · ${tally(c) || 'nothing due'}` : ''}`
      if (reply.mode === 'local') return `Local decks from ${String(reply.collection)}, no AnkiWeb sync · ${deck}. /anki login to sync with AnkiWeb.${problem}`
      if (reply.mode === 'ankiweb') return `Syncing with AnkiWeb as ${String(reply.username)} · ${deck} · ${unsynced + (pending ? 1 : 0)} reviews to sync.${problem}`
      return `${NOTHING_SET_UP}${problem}`
    }
    default:
      return 'Usage: /anki [status | login | setup [folder] | deck [name] | sync | download | upload | logout]'
  }
}

type Ui = ReturnType<EngineInterface['ui']['resolve']>

/**
 * A card side drawn from its lines: styled runs, and furigana stacked over
 * its word. A line with furigana is a wrapping row of two-row columns; one
 * without is a single line of text. `base` is the side's own colour.
 */
function cardSide({ ui, lines, fallback, prefix, base }: { ui: Ui; lines?: Seg[][]; fallback: string; prefix: string; base?: string }) {
  const { Box, Text } = ui
  if (!lines?.length) return <Text color={base}>{prefix}{fallback || '(empty)'}</Text>
  const styled = (seg: Seg, key: string, text = seg.t) => (
    <Text key={key} color={seg.c ?? base} bold={seg.b} italic={seg.i} underline={seg.u}>{text}</Text>
  )

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const lead = i === 0 ? prefix : '  '
        if (!line.some(seg => seg.r)) {
          return <Text key={`l${i}`} color={base}>{lead}{line.map((seg, j) => styled(seg, `s${j}`))}</Text>
        }
        return (
          <Box key={`l${i}`} flexDirection="row" flexWrap="wrap">
            <Box flexDirection="column"><Text> </Text><Text color={base}>{lead}</Text></Box>
            {line.flatMap((seg, j) => seg.r
              ? [
                <Box key={`s${j}`} flexDirection="column" alignItems="center">
                  <Text dimColor>{seg.r}</Text>
                  {styled(seg, 'base')}
                </Box>,
              ]
              : wrapChunks(seg.t).map((chunk, k) => (
                <Box key={`s${j}.${k}`} flexDirection="column">
                  <Text> </Text>
                  {styled(seg, 'base', chunk)}
                </Box>
              )))}
          </Box>
        )
      })}
    </Box>
  )
}

export const register: Register = (on, options) => {
  settings = { ...settings, ...(options as Partial<Settings>) }

  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'anki',
        description: 'Review Anki cards while Claude works',
        argumentHint: 'login (AnkiWeb) | setup [folder] (local) | deck [name] | sync | status',
      })
      .catch(() => undefined)
    void sync($)

    return next(e)
  })

  on('command.run', { command: 'anki' }, async ($, e) => {
    // A toast, not { text }: command text is transcript the model reads.
    const text = await runCommand($, e.args ?? '')
    $.ui.toast(text, { timeoutMs: 8000 })

    return {}
  })

  on('turn.start', async ($, e, next) => {
    // The login window may have finished since: a sync picks the login up.
    if ((await read($, band)).status === 'logged_out' && !isSyncing) void sync($)
    // A sync can take seconds and deals when it ends; don't hold the turn for it.
    // Paused for Anki desktop, the check takes a moment: don't hold the turn for it either.
    if ((await read($, card)) === null && !(await read($, menu)).isOpen) {
      if (isSyncing || (await read($, band)).status === 'desktop_open') void dealNext($)
      else await dealNext($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const hasWork = unsynced > 0 || pending !== null
    if (e.agentId === undefined && hasWork && (await $.clock.now()) - lastSyncAt > SYNC_EVERY_MS) void sync($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (unsynced > 0 || pending !== null) await sync($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !e.props.isWorking) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.min(e.props.bodyColumns, 72)
    const picker = await read($, menu)
    const held = await read($, undoable)

    if (picker.isOpen) {
      // Border, title and footer take 4 rows; digits 1-8 pick, 9 pages on.
      const size = Math.max(1, Math.min(8, e.props.maxRows - 4))
      const { rows, page, pages } = menuPage(picker.decks, picker.page, size)
      const canGoBack = deckChoice !== null && deckChoice !== undefined

      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
          <Box justifyContent="space-between">
            <Text color="cyan" bold>pick a deck</Text>
            <Text dimColor>{pages > 1 ? `${page + 1}/${pages}` : ''}</Text>
          </Box>
          {rows.length === 0
            ? <Text dimColor>no decks yet · /anki to set up</Text>
            : rows.map((row, i) => (
              <Box key={row.name} gap={1}>
                <Button
                  key={`deck-${i + 1}`}
                  hotkey={String(i + 1)}
                  plain
                  label={`${'  '.repeat(Math.max(0, row.level - 1))}${row.name.split('::').at(-1)}`}
                  onPress={() => pickDeck($, row.name)}
                />
                <Text dimColor>{tally(row)}</Text>
              </Box>
            ))}
          <Box gap={2}>
            {pages > 1 && <Button key="more" hotkey={MORE_KEY} plain label="more" onPress={() => update($, menu, m => ({ ...m, page: page + 1 }))} />}
            {canGoBack && <Button key="back" hotkey={DECKS_KEY} plain label="back" onPress={() => closeMenu($)} />}
          </Box>
        </Box>
      )
    }

    const current = await read($, card)
    const { status, deck } = await read($, band)
    const c = await read($, counts)
    const title = deck || 'anki'
    const undoButton = held && <Button key="undo" hotkey={UNDO_KEY} plain label="undo" onPress={() => undo($)} />
    const decksButton = <Button key="decks" hotkey={DECKS_KEY} plain label="decks" onPress={() => openMenu($)} />

    if (current === null) {
      if (status === 'syncing') return <Text dimColor>  {title} · syncing with AnkiWeb…</Text>
      if (status === 'logged_out') return <Text dimColor>  anki · /anki login to pull decks from AnkiWeb, or /anki setup for decks on this computer</Text>
      if (status === 'desktop_open') return <Text dimColor>  anki · paused while Anki desktop is open</Text>
      if (status === 'missing') return <Text dimColor>  anki · couldn't start (/anki status)</Text>
      if (status === 'error') return <Text dimColor>  {title} · /anki status for details</Text>
      if (status === 'empty') {
        return (
          <Box gap={2}>
            <Text dimColor>  {title} · nothing due ✓</Text>
            {undoButton}
            {decksButton}
          </Box>
        )
      }
      return next(e)
    }

    const shown = await read($, isRevealed)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Box justifyContent="space-between">
          <Text color="cyan" bold>{title}</Text>
          <Text dimColor>{c ? tally(c) : ''}</Text>
        </Box>
        {cardSide({ ui: $.ui.resolve(e), lines: current.questionLines, fallback: current.question, prefix: '', base: 'yellow' })}
        {shown
          ? cardSide({ ui: $.ui.resolve(e), lines: current.answerLines, fallback: current.answer, prefix: '→ ' })
          : <Text dimColor>→ ···</Text>}
        <Box gap={2}>
          {shown
            ? GRADES.map(grade => (
              <Button key={grade.name} hotkey={grade.key} plain label={grade.name} onPress={() => answer($, current, grade)} />
            ))
            : <Button key="show" hotkey={SHOW_KEY} plain label="show" onPress={() => reveal($)} />}
          {undoButton}
          {decksButton}
        </Box>
      </Box>
    )
  })
}
