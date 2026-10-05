import { describe, expect, mock, test } from 'claude-code/testing'

import { appleScriptString, menuPage, parseReply, shellQuote, syncEndpoint, tally } from '../hooks/register'

const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}
const BIN = '/plugins/anki/bin/anki-claude-mod-sidecar'
const DECKS = [
  { name: 'Japanese', level: 1, new: 1, learning: 0, review: 4 },
  { name: 'Svensk', level: 1, new: 5, learning: 0, review: 0 },
  { name: 'Svensk::Verb', level: 2, new: 3, learning: 0, review: 0 },
]

type Call = { args: string[]; stdin?: string }
type Fake = { isMissing?: boolean; installs?: string[][]; decks?: typeof DECKS; cards?: { question: string; answer: string }[] }

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

// Stands in for the Rust sidecar: the same commands and JSON replies.
function fakeSidecar(calls: Call[], fake: Fake = {}) {
  const queue = (fake.cards ?? [
    { question: 'att förhandla', answer: 'вести переговоры' },
    { question: 'понятие', answer: 'ett begrepp' },
    { question: 'en stol', answer: 'стул' },
  ]).map((c, i) => ({ id: 100 + i, kind: 'new', ...c }))
  const decks = fake.decks ?? DECKS

  return async (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    if (fake.isMissing) return { deny: 'ENOENT: no such file or directory' }
    const done = (reply: { ok: boolean; [key: string]: unknown }) => ({
      value: { exitCode: reply.ok ? 0 : 1, stdout: `${JSON.stringify(reply)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'sh') {
      fake.installs?.push([...e.argv])
      return done({ ok: true, path: BIN, source: 'release' })
    }
    expect(e.argv[0]).toBe(BIN)
    const [, command = '', ...rest] = e.argv
    calls.push({ args: [command, ...rest], stdin: e.init?.stdin })
    const counts = { new: queue.length, learning: 0, review: 0 }
    const deck = flag(rest, '--deck')

    if (command === 'sync') return done({ ok: true, result: 'synced' })
    if (command === 'decks') return done({ ok: true, decks })
    if (command === 'next') {
      if (deck && !decks.some(d => d.name === deck)) return done({ ok: false, code: 'no_deck', message: `no deck named ${deck}` })
      const skip = Number(flag(rest, '--skip'))
      return done({ ok: true, deck, card: queue.find(c => c.id !== skip) ?? null, counts })
    }
    if (command === 'answer') {
      const at = queue.findIndex(c => c.id === Number(flag(rest, '--card')))
      if (at >= 0) queue.splice(at, 1)
      return done({ ok: true, counts: { ...counts, new: queue.length } })
    }
    return done({ ok: true })
  }
}

function sidecarCalls(calls: Call[], command: string) {
  return calls.filter(c => c.args[0] === command).map(c => c.args.slice(1))
}

describe('reviewing', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`reveals and grades a card on ${surface}`, async ($, on) => {
      const calls: Call[] = []
      mock.clock(on, { now: 1000 })
      mock.store(on, { deck: 'Svensk' })
      on('turn.start', (_$, e) => ({ turnId: e.turnId }))
      on('process.run', fakeSidecar(calls))
      await $.turn.start({ text: 'hej', turnId: 't1' })

      expect(sidecarCalls(calls, 'next')).toEqual([['--deck', 'Svensk']])
      const ui = await $.ui.mount({ plugin: 'anki', surface, component: 'AbovePrompt', props: PROPS })
      expect(await ui.find({ type: 'Text', text: 'Svensk' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '3 new' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()
      expect(await ui.find({ text: /вести переговоры/ })).toBeUndefined()

      await ui.press({ key: 'show' })
      expect(await ui.find({ type: 'Text', text: '→ вести переговоры' })).toBeDefined()

      await ui.press({ key: 'good' })
      expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('a double tap on 1 shows the answer without grading again', async ($, on) => {
    const calls: Call[] = []
    const clock = mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })

    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'again' })
    expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()

    await clock.advance(500)
    await ui.press({ key: 'again' })
    expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()
    await ui.unmount()
  })

  test('a card stays up across turns until it is graded', async ($, on) => {
    const calls: Call[] = []
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    await $.turn.start({ text: 'again', turnId: 't2' })

    expect(sidecarCalls(calls, 'next')).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()
    await ui.unmount()
  })

  test('says nothing is due', async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar([], { cards: [] }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /Svensk · nothing due/ })).toBeDefined()
    expect(await ui.find({ key: 'decks' })).toBeDefined()
    await ui.unmount()
  })

  test('stays out of the way between turns', async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar([]))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, isWorking: false } })
    expect(await ui.find({ text: /att förhandla/ })).toBeUndefined()
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    await ui.unmount()
  })
})

describe('undo', () => {
  test('holds a grade back, so undo brings the card back without touching Anki', async ($, on) => {
    const calls: Call[] = []
    const clock = mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ key: 'undo' })).toBeUndefined()
    await ui.press({ key: 'show' })
    await clock.advance(2000)
    await ui.press({ key: 'good' })
    expect(sidecarCalls(calls, 'answer')).toEqual([])
    expect(sidecarCalls(calls, 'next').at(-1)).toEqual(['--deck', 'Svensk', '--skip', '100'])
    expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()

    await ui.press({ key: 'undo' })
    expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()
    expect(await ui.find({ text: /вести переговоры/ })).toBeUndefined()
    expect(await ui.find({ key: 'undo' })).toBeUndefined()
    expect(sidecarCalls(calls, 'answer')).toEqual([])
    await ui.unmount()
  })

  test('the next grade makes the held one final, with the time it was pressed', async ($, on) => {
    const calls: Call[] = []
    const clock = mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    await ui.press({ key: 'show' })
    await clock.advance(3000)
    await ui.press({ key: 'hard' })
    await clock.advance(1000)
    await ui.press({ key: 'show' })
    await clock.advance(1000)
    await ui.press({ key: 'easy' })

    expect(sidecarCalls(calls, 'answer')).toEqual([['--card', '100', '--rating', 'hard', '--ms', '3000', '--at', '4000']])
    expect(sidecarCalls(calls, 'next').at(-1)).toEqual(['--deck', 'Svensk', '--skip', '101'])
    await ui.unmount()
  })

  test('a grade pressed twice is held once', async ($, on) => {
    const calls: Call[] = []
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })

    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'show' })
    await Promise.all([ui.press({ key: 'easy' }), ui.press({ key: 'easy' })])
    expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()
    expect(sidecarCalls(calls, 'answer')).toEqual([])
    await ui.unmount()
  })
})

describe('decks', () => {
  test('asks for a deck when none is picked', async ($, on) => {
    const calls: Call[] = []
    mock.clock(on, { now: 1000 })
    mock.store(on)
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })

    expect(sidecarCalls(calls, 'next')).toEqual([])
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'pick a deck' })).toBeDefined()
    expect(await ui.find({ text: /Verb/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 new · 4 due' })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()

    await ui.press({ key: 'deck-3' })
    expect(sidecarCalls(calls, 'next')).toEqual([['--deck', 'Svensk::Verb']])
    expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()
    await ui.unmount()
  })

  test('0 opens the menu over a card and goes back', async ($, on) => {
    const calls: Call[] = []
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    await ui.press({ key: 'decks' })
    expect(await ui.find({ type: 'Text', text: 'pick a deck' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()
    await ui.unmount()
  })

  test('switching decks makes a held grade final first', async ($, on) => {
    const calls: Call[] = []
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    await ui.press({ key: 'show' })
    await ui.press({ key: 'good' })
    await ui.press({ key: 'decks' })
    await ui.press({ key: 'deck-1' })
    expect(sidecarCalls(calls, 'answer')).toHaveLength(1)
    expect(sidecarCalls(calls, 'next').at(-1)).toEqual(['--deck', 'Japanese'])
    await ui.unmount()
  })

  test('asks again when the remembered deck is gone', async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Deleted' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar([]))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'pick a deck' })).toBeDefined()
    await ui.unmount()
  })
})

describe('sidecar', () => {
  test('installs it once, then runs it from where the installer put it', async ($, on) => {
    const calls: Call[] = []
    const installs: string[][] = []
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls, { installs }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'good' })

    expect(installs).toHaveLength(1)
    expect(installs[0]![1]).toMatch(/scripts\/install-sidecar\.sh$/)
    expect(calls.map(c => c.args[0])).toEqual(['next', 'next'])
    await ui.unmount()
  })

  test('says it is unavailable when it can\'t be found', async ($, on) => {
    mock.clock(on, { now: 1000 })
    mock.store(on, { deck: 'Svensk' })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar([], { isMissing: true }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /sidecar unavailable/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('helpers', () => {
  test('reads the last stdout line as the reply', async () => {
    expect(parseReply('noise\n{"ok":true,"result":"synced"}\n', '')).toEqual({ ok: true, result: 'synced' })
  })

  test('turns a crash into a failed reply', async () => {
    expect(parseReply('', 'thread main panicked')).toEqual({ ok: false, code: 'crash', message: 'thread main panicked' })
    expect(parseReply('{"nope":1}', '')).toMatchObject({ ok: false, code: 'crash' })
  })

  test('tally skips empty queues', async () => {
    expect(tally({ new: 3, learning: 0, review: 12 })).toBe('3 new · 12 due')
    expect(tally({ new: 0, learning: 0, review: 0 })).toBe('')
  })

  test('AnkiWeb\'s own address means the default server', async () => {
    expect(syncEndpoint('https://sync.ankiweb.net/')).toBeUndefined()
    expect(syncEndpoint('https://sync.ankiweb.net')).toBeUndefined()
    expect(syncEndpoint('')).toBeUndefined()
    expect(syncEndpoint(' http://nas.local:8080/ ')).toBe('http://nas.local:8080/')
  })

  test('menu pages wrap around', async () => {
    const decks = Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, level: 1, new: 0, learning: 0, review: 0 }))
    expect(menuPage(decks, 0, 8).rows.map(d => d.name)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'])
    expect(menuPage(decks, 1, 8)).toMatchObject({ page: 1, pages: 2 })
    expect(menuPage(decks, 1, 8).rows.map(d => d.name)).toEqual(['d8', 'd9'])
    expect(menuPage(decks, 2, 8).page).toBe(0)
    expect(menuPage([], 0, 8)).toEqual({ rows: [], page: 0, pages: 1 })
  })

  test('quotes the login command for sh and AppleScript', async () => {
    expect(shellQuote("/Users/me/it's here/sidecar")).toBe("'/Users/me/it'\\''s here/sidecar'")
    expect(appleScriptString('\'/a b/c\' "x" \\')).toBe('"\'/a b/c\' \\"x\\" \\\\"')
  })
})
