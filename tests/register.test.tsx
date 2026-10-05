import { describe, expect, mock, test } from 'claude-code/testing'

import { gradeButtons, hotkey, parseReply, tally } from '../hooks/register'

const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

type Call = { args: string[]; stdin?: string }
type Fake = { loggedIn?: boolean; isMissing?: boolean; installs?: string[][]; cards?: { question: string; answer: string }[] }

// Stands in for the Rust sidecar: the same commands and JSON replies.
function fakeSidecar(calls: Call[], fake: Fake = {}) {
  const { loggedIn = true, isMissing = false } = fake
  const queue = (fake.cards ?? [
    { question: 'att förhandla', answer: 'вести переговоры' },
    { question: 'понятие', answer: 'ett begrepp' },
  ]).map((c, i) => ({ id: 100 + i, kind: 'new', ...c }))

  return async (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    if (isMissing) return { deny: 'ENOENT: no such file or directory' }
    const done = (reply: object) => ({
      value: { exitCode: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'sh') {
      fake.installs?.push([...e.argv])
      return done({ ok: true, path: '/plugins/anki-wait/bin/anki-wait-sidecar', source: 'release' })
    }
    expect(e.argv[0]).toBe('/plugins/anki-wait/bin/anki-wait-sidecar')
    const [, command, ...rest] = e.argv
    calls.push({ args: [command!, ...rest], stdin: e.init?.stdin })
    const counts = { new: queue.length, learning: 0, review: 0 }
    const reply =
      command === 'sync' ? (loggedIn ? { ok: true, result: 'synced' } : { ok: false, code: 'logged_out', message: 'run /anki login first' })
      : command === 'next' ? { ok: true, deck: rest[1] ?? 'Default', card: queue[0] ?? null, counts }
      : command === 'answer' ? (queue.shift(), { ok: true, counts: { ...counts, new: queue.length } })
      : command === 'login' ? { ok: true, username: 'me@example.com' }
      : { ok: true }
    return { value: { exitCode: reply.ok ? 0 : 1, stdout: `${JSON.stringify(reply)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }
}

function sidecarCalls(calls: Call[], command: string) {
  return calls.filter(c => c.args[0] === command).map(c => c.args.slice(1))
}

const SVENSK = { options: { deck: 'Svensk' } }

describe('register', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`reveals and grades a due card on ${surface}`, SVENSK, async ($, on) => {
      const calls: Call[] = []
      mock.clock(on, { now: 1000 })
      on('turn.start', (_$, e) => ({ turnId: e.turnId }))
      on('process.run', fakeSidecar(calls))
      await $.turn.start({ text: 'hej', turnId: 't1' })

      expect(sidecarCalls(calls, 'next')).toEqual([['--deck', 'Svensk']])
      const ui = await $.ui.mount({ plugin: 'anki-wait', surface, component: 'AbovePrompt', props: PROPS })
      expect(await ui.find({ type: 'Text', text: 'Svensk' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2 new' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()
      expect(await ui.find({ text: /вести переговоры/ })).toBeUndefined()

      await ui.press({ key: 'show' })
      expect(await ui.find({ type: 'Text', text: '→ вести переговоры' })).toBeDefined()

      await ui.press({ key: 'good' })
      expect(sidecarCalls(calls, 'answer')).toEqual([['--card', '100', '--rating', 'good', '--ms', '0']])
      expect(await ui.find({ type: 'Text', text: 'понятие' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '1 new' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('a double tap on a shared show/again key does not grade', { options: { againKey: '1' } }, async ($, on) => {
    const calls: Call[] = []
    const clock = mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })

    const ui = await $.ui.mount({ plugin: 'anki-wait', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'again' })
    expect(sidecarCalls(calls, 'answer')).toEqual([])

    await clock.advance(500)
    await Promise.all([ui.press({ key: 'easy' }), ui.press({ key: 'easy' })])
    expect(sidecarCalls(calls, 'answer')).toHaveLength(1)
    await ui.unmount()
  })

  test('a card stays up across turns until it is graded', async ($, on) => {
    const calls: Call[] = []
    mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    await $.turn.start({ text: 'again', turnId: 't2' })

    expect(sidecarCalls(calls, 'next')).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'anki-wait', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'att förhandla' })).toBeDefined()
    await ui.unmount()
  })

  test('uses the collection\'s current deck when none is configured', async ($, on) => {
    const calls: Call[] = []
    mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    expect(sidecarCalls(calls, 'next')).toEqual([[]])
  })

  test('says nothing is due', SVENSK, async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar([], { cards: [] }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki-wait', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /Svensk · nothing due/ })).toBeDefined()
    await ui.unmount()
  })

  test('installs the sidecar once, then runs it from where the installer put it', async ($, on) => {
    const calls: Call[] = []
    const installs: string[][] = []
    mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar(calls, { installs }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki-wait', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'good' })

    expect(installs).toHaveLength(1)
    expect(installs[0]![1]).toMatch(/scripts\/install-sidecar\.sh$/)
    expect(calls.map(c => c.args[0])).toEqual(['next', 'answer', 'next'])
    await ui.unmount()
  })

  test('says the sidecar is unavailable when it can\'t be found', async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar([], { isMissing: true }))
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki-wait', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /sidecar unavailable/ })).toBeDefined()
    await ui.unmount()
  })

  test('stays out of the way between turns', async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('process.run', fakeSidecar([]))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })
    await $.turn.start({ text: 'hej', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'anki-wait', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, isWorking: false } })
    expect(await ui.find({ text: /att förhandla/ })).toBeUndefined()
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    await ui.unmount()
  })
})

describe('replies', () => {
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
})

describe('keys', () => {
  test('default layout is show 1, again 2, good 3, easy 4', async () => {
    const defaults = { ankiwebUsername: '', ankiwebPassword: '', syncServer: '', deck: '', sidecarPath: '', showKey: '1', againKey: '2', hardKey: '', goodKey: '3', easyKey: '4' }
    expect(gradeButtons(defaults).map(g => `${g.key}:${g.name}`)).toEqual(['2:again', '3:good', '4:easy'])
  })

  test('rejects keys the engine would refuse', async () => {
    expect(hotkey(' ')).toBeUndefined()
    expect(hotkey('space')).toBeUndefined()
    expect(hotkey('E')).toBe('e')
  })
})
