import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event, SessionSummary, Summary } from '@/lib/api'
import { heldSessions } from '@/lib/sessionEvents'
import { DECK_STEP } from '@/lib/deck'

const now = Date.now()
const iso = (agoMs: number) => new Date(now - agoMs).toISOString()
const events: Event[] = [
  { id: 1, ts: iso(60_000), session_id: 's1', source: 'transcript', kind: 'turn.assistant', payload: {}, cost_usd: 0.04 },
  { id: 2, ts: iso(30_000), session_id: 's1', source: 'transcript', kind: 'turn.assistant', payload: {}, cost_usd: 0.07 },
  { id: 3, ts: iso(4_000), session_id: 's1', source: 'hook', kind: 'tool.pre', tool: 'Bash', payload: { tool_use_id: 'b', tool_input: { command: 'go test ./internal/...' } } },
]

const h = vi.hoisted(() => ({ asked: 0, prs: { connected: true, prs: [] as unknown[] } }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, recentMainEvents: async () => { h.asked++; return events }, sessionPRs: async () => h.prs } }
})

import { SessionDeck } from './SessionDeck'

function agent(p: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 's1', cwd: '/w', project: 'w', model: 'claude-opus-5-5', model_display: 'Opus 5.5', started_at: 0, last_event_at: now, status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true, agent: 'claude',
    stats: { session_id: 's1', turns: 12, tool_calls: 40, files_touched: 3, tokens_in: 100, tokens_out: 9_000, cache_read: 900_000, cache_write: 50_000, cost_usd: 1.84 },
    activity: { phrase: 'running go test', tool: 'Bash', at: iso(4_000), health: 'working' },
    context: { tokens: 124_000, window: 200_000, pct: 62, next_call_usd: 0.031 },
    ...p,
  } as SessionSummary
}

const summary = { rate_limits: { five_hour: { used_percentage: 41, resets_at: Math.round((now + 3_600_000) / 1000) }, seven_day: { used_percentage: 12, resets_at: Math.round((now + 3 * 86_400_000) / 1000) } } } as unknown as Summary

function show(p: Partial<Parameters<typeof SessionDeck>[0]> = {}) {
  const onResize = vi.fn()
  const r = render(<SessionDeck s={agent()} sessionId="s1" hasPermission={false} summary={summary} height={120} onResize={onResize} onClose={() => {}} {...p} />)
  return { ...r, onResize }
}

afterEach(() => { vi.useRealTimers(); h.asked = 0 })

describe('the session deck', () => {
  it('reads what the session is doing, what it cost and its context', async () => {
    show()
    expect(screen.getByRole('status')).toHaveTextContent('Working')
    expect(screen.getByLabelText('Cost $1.84')).toBeInTheDocument()
    expect(await screen.findByText('go test ./internal/...')).toBeInTheDocument()
    expect(screen.getByText(/last call/)).toHaveTextContent('$0.07')
    expect(screen.getByRole('meter', { name: 'Context used' })).toHaveAttribute('aria-valuenow', '62')
    expect(screen.getByText(/next call/)).toHaveTextContent('$0.03')
  })

  it('leaves out what the agent does not report rather than drawing a zero', () => {
    show({ s: agent({ context: undefined, stats: undefined, agent: 'opencode' }) })
    expect(screen.queryByRole('meter', { name: 'Context used' })).toBeNull()
    expect(screen.queryByText('Spent')).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  it('shows the branch with what is not committed and not pushed', async () => {
    show({ branch: 'feat/deck', changed: 3, ahead: 2, onReviewChanges: () => {} })
    await screen.findByText('go test ./internal/...')
    expect(screen.getByText('feat/deck')).toBeInTheDocument()
    expect(screen.getByText('3 not committed · 2 not pushed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeInTheDocument()
  })

  it('lists the session’s PRs with their CI', async () => {
    const pr = (n: number, checks: object, state = 'open') => ({ number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, state, draft: false, review: '', reviews: [], checks })
    h.prs = { connected: true, prs: [
      { session_id: 's1', number: 9, url: 'https://github.com/a/b/pull/9', title: 'PR 9', last_at: now, live: pr(9, { state: 'pending', passed: 2, failed: 0, pending: 3, items: [{}, {}, {}, {}, {}] }) },
      { session_id: 's1', number: 8, url: 'https://github.com/a/b/pull/8', title: 'PR 8', last_at: now, live: pr(8, { state: 'fail', passed: 1, failed: 1, pending: 0, items: [{ name: 'windows', state: 'fail' }, { name: 'lint', state: 'pass' }] }) },
      { session_id: 's1', number: 7, url: 'https://github.com/a/b/pull/7', title: 'PR 7', last_at: now, live: pr(7, { state: 'pass', passed: 1, failed: 0, pending: 0, items: [{}] }, 'merged') },
    ] }
    show()
    expect(await screen.findByText('CI 2/5')).toBeInTheDocument()
    expect(screen.getByText('CI failed: windows')).toBeInTheDocument()
    expect(screen.getByText('merged')).toBeInTheDocument()
    h.prs = { connected: true, prs: [] }
  })

  it('says how to get CI while GitHub is not connected', async () => {
    h.prs = { connected: false, prs: [{ session_id: 's1', number: 4, url: 'https://github.com/a/b/pull/4', title: 'PR 4', last_at: now, merged_at: now }] }
    show()
    expect(await screen.findByText('connect GitHub for CI')).toBeInTheDocument()
    expect(screen.getByText('merged')).toBeInTheDocument()
    h.prs = { connected: true, prs: [] }
  })

  it('has room for the recent calls only when tall', async () => {
    const { rerender } = show()
    await screen.findByText('go test ./internal/...')
    expect(screen.queryByText('12 turns')).toBeNull()
    rerender(<SessionDeck s={agent()} sessionId="s1" hasPermission={false} summary={summary} height={220} onResize={() => {}} onClose={() => {}} />)
    expect(screen.getByText('12 turns')).toBeInTheDocument()
    expect(screen.getByText('40 tool calls')).toBeInTheDocument()
  })

  it('resizes the terminal once, on release, however far the divider is dragged', () => {
    const { onResize } = show()
    const divider = screen.getByRole('separator', { name: 'Resize the session deck' })
    fireEvent.pointerDown(divider, { button: 0, clientY: 500 })
    for (const y of [490, 470, 440, 400]) fireEvent.pointerMove(window, { clientY: y })
    // Drawn at the new height over the terminal meanwhile, the terminal untouched.
    expect(onResize).not.toHaveBeenCalled()
    expect(divider).toHaveAttribute('aria-valuenow', '220')
    fireEvent.pointerUp(window, { clientY: 400 })
    expect(onResize).toHaveBeenCalledTimes(1)
  })

  it('settles the arrow keys into one resize', () => {
    vi.useFakeTimers()
    const { onResize } = show()
    const divider = screen.getByRole('separator', { name: 'Resize the session deck' })
    for (let i = 0; i < 5; i++) fireEvent.keyDown(divider, { key: 'ArrowUp' })
    expect(onResize).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(300) })
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize.mock.calls[0]![0]).toBeGreaterThanOrEqual(5 * DECK_STEP)
  })

  it('lets go of the session’s events when it closes', async () => {
    const { unmount } = show()
    await waitFor(() => expect(h.asked).toBe(1))
    expect(heldSessions()).toBe(1)
    unmount()
    expect(heldSessions()).toBe(0)
  })
})
