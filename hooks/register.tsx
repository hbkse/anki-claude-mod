import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band, Card, Counts } from '../types'

// The sidecar (sidecar/, Rust over Anki's own core) owns the collection and
// talks to AnkiWeb. This module only draws the band and runs the sidecar, one
// call at a time: it holds an exclusive lock on the collection while it runs.

const GRADES = [
  { name: 'again', ease: 1 },
  { name: 'hard', ease: 2 },
  { name: 'good', ease: 3 },
  { name: 'easy', ease: 4 },
] as const
const GRADE_DELAY_MS = 400
const MAX_ANSWER_MS = 60_000
const SYNC_EVERY_MS = 10 * 60_000
const SYNC_TIMEOUT_MS = 120_000
const CALL_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 180_000

const card = atom({ plugin: 'anki', key: 'card' } as const, null)
const isRevealed = atom({ plugin: 'anki', key: 'isRevealed' } as const, false)
const band = atom({ plugin: 'anki', key: 'band' } as const, { status: 'idle', deck: '' })
const counts = atom({ plugin: 'anki', key: 'counts' } as const, null)

type Grade = (typeof GRADES)[number]['name']
type Settings = {
  ankiwebUsername: string
  ankiwebPassword: string
  syncServer: string
  deck: string
  showKey: string
} & Record<`${Grade}Key`, string>

export type Reply = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string }

let settings: Settings = {
  ankiwebUsername: '',
  ankiwebPassword: '',
  syncServer: '',
  deck: '',
  showKey: '1',
  againKey: '2',
  hardKey: '',
  goodKey: '3',
  easyKey: '4',
}
let calls: Promise<unknown> = Promise.resolve()
let binPath: string | null = null
let dealing: Promise<void> | null = null
let shownAt = 0
let revealedAt = 0
let lastSyncAt = 0
let unsynced = 0
let isSyncing = false

export function hotkey(key: string | undefined): string | undefined {
  const value = key?.trim().toLowerCase() ?? ''

  return /^[0-9a-z]$/.test(value) ? value : undefined
}

export function gradeButtons(keys: Settings): { name: Grade; key: string }[] {
  const taken = new Set<string>()

  return GRADES.flatMap(({ name }) => {
    const key = hotkey(keys[`${name}Key`])
    if (key === undefined || taken.has(key)) return []
    taken.add(key)
    return [{ name, key }]
  })
}

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

// Whatever the install script leaves in bin/: a local build, or the release
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

function deckName(): string {
  return settings.deck.trim()
}

async function setBand($: EngineInterface, next: Band): Promise<void> {
  await update($, band, (): Band => next)
}

async function failed($: EngineInterface, reply: Extract<Reply, { ok: false }>): Promise<void> {
  // Another session holds the collection for a moment; try again next turn.
  if (reply.code === 'busy') return
  const status: Band['status'] =
    reply.code === 'logged_out' || reply.code === 'auth' ? 'logged_out'
    : ['missing', 'unsupported', 'checksum'].includes(reply.code) ? 'missing'
    : 'error'
  await setBand($, { status, deck: deckName(), message: reply.message })
  await update($, card, () => null)
}

async function deal($: EngineInterface): Promise<void> {
  const deck = deckName()
  const reply = await sidecar($, deck ? ['next', '--deck', deck] : ['next'])
  if (!reply.ok) return failed($, reply)

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

async function sync($: EngineInterface, mode: '' | '--full-download' | '--full-upload' = ''): Promise<Reply> {
  if ((await read($, card)) === null) await setBand($, { status: 'syncing', deck: deckName() })
  isSyncing = true
  const reply = await sidecar($, mode ? ['sync', mode] : ['sync'], { timeoutMs: SYNC_TIMEOUT_MS }).finally(() => {
    isSyncing = false
  })
  if (reply.ok) {
    lastSyncAt = await $.clock.now()
    unsynced = 0
    if (reply.result === 'full_sync_required') {
      $.ui.toast('AnkiWeb needs a one-way sync: /anki download (take AnkiWeb\'s copy) or /anki upload', { timeoutMs: 10_000 })
    }
  } else if (reply.code !== 'busy') {
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
  const sharesShowKey = gradeButtons(settings).some(g => g.key === hotkey(settings.showKey))
  if (sharesShowKey && now - revealedAt < GRADE_DELAY_MS) return

  let isClaimed = false
  await update($, card, c => {
    isClaimed = c?.id === shown.id
    return isClaimed ? null : c
  })
  if (!isClaimed) return

  const ms = Math.max(0, Math.min(now - shownAt, MAX_ANSWER_MS))
  const reply = await sidecar($, ['answer', '--card', String(shown.id), '--rating', grade, '--ms', String(ms)])
  if (!reply.ok) return failed($, reply)
  unsynced++
  await dealNext($)
}

async function login($: EngineInterface): Promise<string> {
  const username = settings.ankiwebUsername.trim()
  if (!username || !settings.ankiwebPassword) {
    return 'Set your AnkiWeb email and password in /config (anki), then run /anki login.'
  }
  const reply = await sidecar($, ['login'], {
    stdin: JSON.stringify({ username, password: settings.ankiwebPassword, endpoint: settings.syncServer.trim() || undefined }),
    timeoutMs: SYNC_TIMEOUT_MS,
  })
  if (!reply.ok) return `Login failed: ${reply.message}`

  // The sync key is all we need from here on; don't keep the password around.
  await $.config.set({ key: 'anki.ankiwebPassword', value: '' }).catch(() => undefined)
  const synced = await sync($)

  return synced.ok ? `Logged in to AnkiWeb as ${username} and synced.` : `Logged in as ${username}; sync failed: ${synced.message}`
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [sub = 'status'] = args.trim().split(/\s+/).filter(Boolean)
  switch (sub) {
    case 'login':
      return login($)
    case 'logout': {
      await sidecar($, ['logout'])
      await update($, card, () => null)
      await setBand($, { status: 'logged_out', deck: deckName() })
      return 'Logged out. Your local copy stays until you log in as someone else.'
    }
    case 'sync':
    case 'download':
    case 'upload': {
      const mode = sub === 'download' ? '--full-download' : sub === 'upload' ? '--full-upload' : ''
      const reply = await sync($, mode)
      return reply.ok ? `AnkiWeb: ${String(reply.result).replace(/_/g, ' ')}` : `Sync failed: ${reply.message}`
    }
    case 'decks': {
      const reply = await sidecar($, ['decks'])
      return reply.ok ? (reply.decks as string[]).join('\n') : `Couldn't list decks: ${reply.message}`
    }
    case 'status': {
      const reply = await sidecar($, ['status'])
      if (!reply.ok) return `Sidecar unavailable: ${reply.message}`
      const c = await read($, counts)
      return reply.loggedIn
        ? `AnkiWeb: ${String(reply.username)} · deck ${deckName() || '(current)'}${c ? ` · ${tally(c) || 'nothing due'}` : ''} · ${unsynced} unsynced`
        : 'Not logged in. Set your AnkiWeb email and password in /config, then /anki login.'
    }
    default:
      return 'Usage: /anki [status|login|logout|sync|download|upload|decks]'
  }
}

export const register: Register = (on, options) => {
  settings = { ...settings, ...(options as Partial<Settings>) }

  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'anki',
        description: 'AnkiWeb reviews while Claude works',
        argumentHint: 'status|login|logout|sync|download|upload|decks',
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
    // A sync can take seconds and deals when it ends; don't hold the turn for it.
    if ((await read($, card)) === null) {
      if (isSyncing) void dealNext($)
      else await dealNext($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && unsynced > 0 && (await $.clock.now()) - lastSyncAt > SYNC_EVERY_MS) void sync($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (unsynced > 0) await sync($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !e.props.isWorking) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, card)
    const { status, deck } = await read($, band)
    const c = await read($, counts)
    const title = deck || 'anki'

    if (current === null) {
      if (status === 'syncing') return <Text dimColor>  {title} · syncing with AnkiWeb…</Text>
      if (status === 'logged_out') return <Text dimColor>  anki · /anki login to review while Claude works</Text>
      if (status === 'missing') return <Text dimColor>  anki · sidecar unavailable (/anki status)</Text>
      if (status === 'error') return <Text dimColor>  {title} · /anki status for details</Text>
      if (status === 'empty') return <Text dimColor>  {title} · nothing due ✓</Text>
      return next(e)
    }

    const shown = await read($, isRevealed)

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        width={Math.min(e.props.bodyColumns, 72)}
      >
        <Box justifyContent="space-between">
          <Text color="cyan" bold>{title}</Text>
          <Text dimColor>{c ? tally(c) : ''}</Text>
        </Box>
        <Text bold color="yellow">{current.question || '(empty)'}</Text>
        {shown
          ? (
            <Box flexDirection="column">
              <Text>→ {current.answer || '(empty)'}</Text>
              <Box gap={2}>
                {gradeButtons(settings).map(grade => (
                  <Button key={grade.name} hotkey={grade.key} plain label={grade.name} onPress={() => answer($, current, grade.name)} />
                ))}
              </Box>
            </Box>
          )
          : (
            <Box gap={2}>
              <Text dimColor>→ ···</Text>
              <Button key="show" hotkey={hotkey(settings.showKey)} plain label="show" onPress={() => reveal($)} />
            </Box>
          )}
      </Box>
    )
  })
}
