import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ago, classifyTaskLine, deriveProgress, lastCwd, ledgerDir, parseMinor, parsePlan, parseRuling, parseSummaryReply, planFor, labelKeys, summaryPrompt, taskDetails, textKey } from '../mods/plan-progress/parse.js'

const expect = (a) => ({ toBe: (b) => assert.equal(a, b), toEqual: (b) => assert.deepEqual(a, b) })

const PLAN = Array.from({ length: 12 }, (_, i) => `### Task ${i + 1}: Name ${i + 1}\nbody\n`).join('\n')

const LEDGER = `# SDD ledger
Spec: docs/x.md

## Pre-flight scan
| Tasks | Finding |
|---|---|
| 1↔4 | thing |

Ruling R1: grant select
Task 1: minor (deferred): duplicate drop policy
Task 1: complete (commits 536d2eb..20af535, review clean)
Task 2: complete (commits 20af535..d10b5b4, review clean)
Task 3: complete (commits d10b5b4..4a0b6a7, review clean)
Task 4: implementer DONE_WITH_CONCERNS 378bc82 (no RED run)
Task 4: minor → carried to Task 5: something
Task 5: fix round 1/5 (9 addressed, 0 open; commits bddd9e8..ee2672f)
Task 6: dispatched (implementer x)
Task 7: implementer DONE_WITH_CONCERNS eeac176 (...)
Task 8: implementer NEEDS_CONTEXT (...)
Task 9: implementer NEEDS_CONTEXT (...)
Task 9: re-dispatched with rulings
Task 10: review abc1234 — 1 Important
Task 10: fix round 2 dispatched
Task 11: something nobody has seen before
Ruling R9: adapter read(id)
Ruling R9a: amend R9
Totally unknown line ~~~
`

test('derives each status from the last status line of a task', () => {
  const p = deriveProgress(PLAN, LEDGER, ['task-12-brief.md'])
  const s = Object.fromEntries(p.tasks.map(t => [t.n, t.status]))

  expect(s[1]).toBe('done') // a deferred minor after/before complete does not change it
  expect(p.tasks[0]?.range).toBe('536d2eb..20af535')
  expect(s[3]).toBe('done')
  expect(p.tasks[2]?.range).toBe('d10b5b4..4a0b6a7')
  expect(s[4]).toBe('in review') // a carried minor is neutral
  expect(s[5]).toBe('fixing')
  expect(p.tasks[4]?.round).toBe(1)
  expect(s[6]).toBe('implementing')
  expect(s[7]).toBe('in review')
  expect(s[8]).toBe('blocked')
  expect(s[9]).toBe('implementing') // re-dispatched after NEEDS_CONTEXT
  expect(s[10]).toBe('fixing')
  expect(p.tasks[9]?.round).toBe(2)
  expect(s[11]).toBe('not started') // unknown line: no status
  expect(s[12]).toBe('implementing') // brief on disk, no ledger line
  expect(p.done).toBe(3)
  expect(p.total).toBe(12)
  expect(p.current).toBe('10')
  expect(p.lastHead).toBe('4a0b6a7')
})

test('collects rulings, deferred minors and unknown lines', () => {
  const p = deriveProgress(PLAN, LEDGER, [])

  expect(p.rulings.length).toBe(3) // R9a, an amended ruling, counts
  expect(p.minors).toEqual(['Task 1: minor (deferred): duplicate drop policy'])
  expect(p.other).toEqual([
    'Spec: docs/x.md',
    'Task 11: something nobody has seen before',
    'Totally unknown line ~~~',
  ])
})

test('blocked by a bare BLOCKED implementer line', () => {
  expect(classifyTaskLine('implementer BLOCKED (no creds)')).toEqual({
    kind: 'status',
    status: 'blocked',
  })
})

test('final review lines and all-done', () => {
  const all = Array.from({ length: 12 }, (_, i) => `Task ${i + 1}: complete (commits a1b2c3d..e4f5a6b)`).join('\n')
  const p = deriveProgress(PLAN, `${all}\nFinal review: 2 Important, fix dispatched\nTask 5: minor (deferred): x (final review to triage)`, [])

  expect(p.done).toBe(12)
  expect(p.current).toBe(undefined)
  expect(p.finalReview).toEqual(['Final review: 2 Important, fix dispatched'])
  expect(p.minors.length).toBe(1) // a task's minor mentioning final review stays a minor
})

test('garbage never throws', () => {
  const p = deriveProgress('', '\u0000\nTask : \nTask x: y\nTask 99: complete\n|||', ['weird'])
  expect(p.total).toBe(0)
  expect(p.other.length).toBe(3)
})

test('plan headings, paths and ages', () => {
  expect(parsePlan('### Task 3: Shared parsing moves to `lib/`\nbody\n### Not a task\nmore')).toEqual([
    { n: '3', name: 'Shared parsing moves to `lib/`', body: 'body' },
  ])
  expect(ledgerDir('/w/', '/w/docs/superpowers/plans/2026-11-20-x.md')).toBe(
    '/w/.superpowers/sdd/2026-11-20-x',
  )
  expect(ago(0, 10_000)).toBe('just now')
  expect(ago(0, 120_000)).toBe('2 min ago')
  expect(ago(0, 3 * 3600_000)).toBe('3 h ago')
})

test('finds the plan of a ledger folder', () => {
  const dir = '/w/.superpowers/sdd/2026-11-20-x'
  expect(planFor('/w', dir, 'docs/superpowers/plans/2026-11-20-x.md\n')).toBe('/w/docs/superpowers/plans/2026-11-20-x.md')
  expect(planFor('/w/', dir, '/elsewhere/p.md')).toBe('/elsewhere/p.md')
  expect(planFor('/w', dir, null)).toBe('/w/docs/superpowers/plans/2026-11-20-x.md')
  expect(planFor('/w', dir, '  \n')).toBe('/w/docs/superpowers/plans/2026-11-20-x.md')
})

test('lettered task ids and unnumbered rulings', () => {
  const plan = '## Part N\n### Task N1: Filter\n### Task N2: Route\n## Part A\n### Task A1: Map\n#### Task A2: Runner\n'
  const ledger = [
    'Ruling: review inline',
    'BASE N1=5e179ad2 A1=690a58b',
    'Task A1: complete (commits 690a58b..afea8a6, review clean)',
    'Task N1: complete',
    'Task N2: implementer DONE 1234abc',
  ].join('\n')
  const p = deriveProgress(plan, ledger, ['task-A2-brief.md'])
  expect(p.tasks.map(t => `${t.n}:${t.status}`).join(' ')).toBe(
    'N1:done N2:in review A1:done A2:implementing')
  expect(p.tasks[2]?.range).toBe('690a58b..afea8a6')
  expect(p.rulings).toEqual(['Ruling: review inline'])
  expect(p.other).toEqual(['BASE N1=5e179ad2 A1=690a58b'])
  expect(p.current).toBe('N2')
})

test('the last cwd in a transcript tail', () => {
  const tail = 'ial line"}\n{"cwd":"/a","x":1}\n{"type":"user","cwd":"/w/.worktrees/plan-x"}\n{"cwd":"/q\\"uote"}\n'
  expect(lastCwd(tail)).toBe('/q"uote')
  expect(lastCwd(tail.split('\n').slice(0, 3).join('\n'))).toBe('/w/.worktrees/plan-x')
  expect(lastCwd('no cwd here')).toBe(undefined)
  expect(lastCwd(null)).toBe(undefined)
})

test('a task section gives its intent and files', () => {
  const t10 = [
    '',
    '**Files:**',
    '- Create: `src/sync/queue.ts`, `docs/tasks/nightly.md`',
    '- Modify: `scripts/build.mjs:65-71`, `src/api/routes.ts` (`createOrder` limit)',
    '',
    '**Interfaces:**',
    '- Produces: `runGate(deps)` and `x.mjs`',
    '- [ ] **Step 6: Commit** `feat(sync): nightly queue, retention and a daily cap`.',
  ].join('\n')
  expect(taskDetails(t10)).toEqual({
    intent: 'nightly queue, retention and a daily cap',
    files: ['src/sync/queue.ts', 'docs/tasks/nightly.md', 'scripts/build.mjs', 'src/api/routes.ts'],
  })
  const t7 = '\n**Files:** Create `ops/probe.mjs`, `ops/probe.test.mjs`. Reuse `eval.mjs`.\n\n**Rows.** Each row sends.\n'
  expect(taskDetails(t7).files).toEqual(['ops/probe.mjs', 'ops/probe.test.mjs', 'eval.mjs'])
  expect(taskDetails(t7).intent).toBe('Each row sends.') // a bold lead-in is dropped
  expect(taskDetails('')).toEqual({ intent: undefined, files: [] })
})

test('each task keeps its ledger history', () => {
  const p = deriveProgress(PLAN, LEDGER, [])
  expect(p.tasks[8]?.history).toEqual(['implementer NEEDS_CONTEXT (...)', 're-dispatched with rulings'])
  expect(p.tasks[10]?.history).toEqual(['something nobody has seen before'])
})

test('a bulleted ledger with the short T<n> form', () => {
  const plan = Array.from({ length: 8 }, (_, i) => `### Task ${i + 1}: N${i + 1}`).join('\n')
  const ledger = [
    '- Task 6: complete (commits cbe6c73..8c6d61a, review clean)',
    '- T7 dispatched BASE 8c6d61a.',
    '- T7 implementer DONE 46ac2d8 (agent a1b2c3d4).',
    '- Ruling (T7 fix): a redirect to the login page counts as denied — cost if wrong: none',
    '- T7 review: Needs fixes (1 Important). Fix round 1 sent.',
    '- Task 7: fix round 2/5 (1 addressed, 0 open; commits 6a780b7..beacc7a)',
    '- T8/T9: docs rewrite after deploy',
    '- T8 dispatched BASE beacc7a.',
  ].join('\n')
  const p = deriveProgress(plan, ledger, [])
  expect(p.tasks.slice(5).map(t => `${t.n}:${t.status}`).join(' ')).toBe('6:done 7:fixing 8:implementing')
  expect(p.tasks[6]?.history.length).toBe(4)
  expect(p.rulings.length).toBe(1)
  expect(p.other).toEqual(['T8/T9: docs rewrite after deploy'])
  expect(p.current).toBe('8')
})

test('a ruling splits into decision, why and cost', () => {
  const ids = ['1', '2', '3', '5', '6', '7', 'A5']
  const r5 = parseRuling('Ruling R5: restart policy `on-failure` (not `always`) — the worker exits 0 only on purpose — cost if wrong: a clean exit leaves the worker down. Carried to Task 6.', ids)
  expect(r5.id).toBe('R5')
  expect(r5.decision).toBe('restart policy `on-failure` (not `always`)')
  expect(r5.why).toBe('the worker exits 0 only on purpose')
  expect(r5.cost).toBe('a clean exit leaves the worker down. Carried to Task 6.')
  expect(r5.tasks).toEqual(['6'])

  const t = parseRuling('Ruling (for T2/T3): the worker stops writing the status line — why: a job could write any text — cost if wrong: one extra line of code in T3.', ids)
  expect(t.tasks).toEqual(['2', '3'])
  expect(t.why).toBe('a job could write any text')
  expect(t.id).toBe(undefined)

  expect(parseRuling('Ruling (A5): held counts as good', ids).tasks).toEqual(['A5'])
  expect(parseRuling('Ruling (Important 1 — the cache bypass): close it', ids).tasks).toEqual([])
  expect(parseRuling('Ruling: per-task review is inline — risk: less independent review', ids).cost).toBe('less independent review')
  expect(parseRuling('Ruling R11a: amend R11', ids).decision).toBe('amend R11')
})

test('a deferred minor names its task', () => {
  expect(parseMinor('Task 5: minor (deferred): a race can overshoot the limit')).toEqual({ task: '5', text: 'a race can overshoot the limit' })
  expect(parseMinor('odd line')).toEqual({ text: 'odd line' })
})

test('a ruling with no task belongs to the task active when it was written', () => {
  const plan = '### Task 1: A\n### Task 2: B\n### Task 3: C'
  const ledger = [
    'Ruling R1: pre-flight call — cost if wrong: x',
    'Task 1: complete (commits aaaa111..bbbb222)',
    'Task 2: implementer NEEDS_CONTEXT (q)',
    'Ruling R2: answer the question — cost if wrong: y',
    'Ruling R3 (for T3): later thing',
    'Task 2: minor (deferred): small',
  ].join('\n')
  const p = deriveProgress(plan, ledger, [])
  expect(p.rulingInfo.map(r => `${r.id}:${r.tasks.join(',') || 'pre'}`).join(' ')).toBe('R1:pre R2:2 R3:3')
  expect(p.tasks.map(t => `${t.n}:${t.rulings}/${t.minors}`).join(' ')).toBe('1:0/0 2:1/1 3:1/0')
})

test('summary keys, prompt and a defensive reply parser', () => {
  expect(textKey('Ruling R1: x')).toBe(textKey('Ruling R1: x'))
  expect(textKey('Ruling R1: x') === textKey('Ruling R1: y')).toBe(false)
  expect(/^[0-9a-f]{8}$/.test(textKey(''))).toBe(true)

  const prompt = summaryPrompt([{ key: 'aaaaaaaa', label: 'R1, T6', text: 'Ruling R1: x' }], ['aaaaaaaa'])
  expect(prompt.includes('[aaaaaaaa] (R1, T6) Ruling R1: x')).toBe(true)
  expect(prompt.includes('NEED: aaaaaaaa')).toBe(true)

  const reply = 'Here:\n{"rulings":{"aaaaaaaa":{"line":" Restart only on crash. ","risk":"medium"},"bbbbbbbb":{"line":"x","risk":"huge"},"nothex!!":{"line":"y"},"cccccccc":{"risk":"low"}},"overview":["Mostly deploy calls.", 3, " "]}'
  expect(parseSummaryReply(reply)).toEqual({
    rulings: { aaaaaaaa: { line: 'Restart only on crash.', risk: 'medium' }, bbbbbbbb: { line: 'x', risk: undefined } },
    overview: ['Mostly deploy calls.'],
  })
  expect(parseSummaryReply('no json')).toEqual({ rulings: {}, overview: [] })
  expect(parseSummaryReply('{broken')).toEqual({ rulings: {}, overview: [] })
  expect(parseSummaryReply(null)).toEqual({ rulings: {}, overview: [] })
})

test('cache keys in an overview become labels', () => {
  expect(labelKeys('check 1e44bfe8 and [f12aaa95] first; 99 tests', { '1e44bfe8': 'R1', f12aaa95: 'R5' })).toBe('check R1 and R5 first; 99 tests')
})
