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

const h = vi.hoisted(() => ({ asked: 0 }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, recentMainEvents: async () => { h.asked++; return events } } }
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
  it('reads what the session is doing, what it cost, its context and the plan windows', async () => {
    show()
    expect(screen.getByRole('status')).toHaveTextContent('Working')
    expect(screen.getByLabelText('Cost $1.84')).toBeInTheDocument()
    expect(await screen.findByText('go test ./internal/...')).toBeInTheDocument()
    expect(screen.getByText(/last call/)).toHaveTextContent('$0.07')
    expect(screen.getByRole('meter', { name: 'Context used' })).toHaveAttribute('aria-valuenow', '62')
    expect(screen.getByText(/next call/)).toHaveTextContent('$0.03')
    expect(screen.getByRole('meter', { name: '5-hour window used' })).toHaveAttribute('aria-valuenow', '41')
    expect(screen.getByRole('meter', { name: 'Weekly window used' })).toHaveAttribute('aria-valuenow', '12')
    expect(screen.getByText('Last 60 min')).toBeInTheDocument()
  })

  it('leaves out what the agent does not report rather than drawing a zero', () => {
    show({ s: agent({ context: undefined, stats: undefined, agent: 'opencode' }) })
    expect(screen.queryByRole('meter', { name: 'Context used' })).toBeNull()
    expect(screen.queryByText('Spent')).toBeNull()
    expect(screen.queryByRole('meter', { name: '5-hour window used' })).toBeNull()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  it('has room for the recent calls and the changed files only when tall', async () => {
    const { rerender } = show({ changed: 3 })
    await screen.findByText('go test ./internal/...')
    expect(screen.queryByText('3 files')).toBeNull()
    rerender(<SessionDeck s={agent()} sessionId="s1" hasPermission={false} summary={summary} height={220} changed={3} onResize={() => {}} onClose={() => {}} />)
    expect(screen.getByText('3 files')).toBeInTheDocument()
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
