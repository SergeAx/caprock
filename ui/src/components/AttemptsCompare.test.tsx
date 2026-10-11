import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AttemptView, AttemptsResponse } from '@/lib/api'

const m = vi.hoisted(() => ({ attempts: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, attempts: m.attempts } }
})

import { AttemptsCompare, attemptDuration, attemptState } from './AttemptsCompare'
import { attemptLabel, sessionTitle, type Dot } from '@/lib/sidebar'

const stats = (cost: number) => ({ session_id: '', turns: 1, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: cost })

function view(n: number, over: Partial<AttemptView> = {}, session: Partial<AttemptView['session']> = {}): AttemptView {
  return {
    session_id: `s${n}`, group_id: 'g', n, total: 3, base: 'main', created_at: 1_000,
    session: { session_id: `s${n}`, cwd: `/w/app/.caprock-worktrees/fix-${n}`, project: 'app', model: 'claude-opus-5', started_at: 1_000, last_event_at: 61_000, status: 'active', transcript_path: '', has_hooks: true, has_transcript: true, git_branch: `caprock/fix-${n}`, version: '', owned: true, agent: 'claude', ...session },
    stats: stats(0),
    changes: { files: 0, additions: 0, deletions: 0 },
    ...over,
  }
}

describe('compare attempts', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('sets each attempt side by side: state, changes, cost, time, and its actions', async () => {
    const res: AttemptsResponse = {
      group: 'g', base: 'main',
      attempts: [
        view(1, { stats: stats(1.25), changes: { files: 4, additions: 120, deletions: 8 } }),
        view(2, { stats: stats(0.4), changes: { files: 2, additions: 30, deletions: 2 } }, { status: 'ended', worked_at: 31_000 }),
        view(3, { stats: stats(0.9), changes: undefined, changes_error: 'its copy has been removed' }),
      ],
    }
    m.attempts.mockResolvedValue(res)
    const onOpen = vi.fn()
    const onReview = vi.fn()
    const dots: Record<string, Dot> = { s1: 'working', s3: 'waiting' }
    render(<AttemptsCompare group="g" title="Fix the login bug" dotFor={(id) => dots[id]} onClose={vi.fn()} onOpen={onOpen} onReview={onReview} />)
    const list = await screen.findByRole('list', { name: 'Attempts' })
    const cards = within(list).getAllByRole('listitem')
    expect(cards).toHaveLength(3)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Compare attempts · Fix the login bug · from main')

    expect(cards[0]).toHaveTextContent('Attempt 1')
    expect(cards[0]).toHaveTextContent('working')
    expect(cards[0]).toHaveTextContent('+120')
    expect(cards[0]).toHaveTextContent('−8')
    expect(cards[0]).toHaveTextContent('$1.25')
    expect(cards[1]).toHaveTextContent('done')
    expect(cards[1]).toHaveTextContent('$0.40')
    expect(cards[1]).toHaveTextContent('cheapest')
    expect(cards[0]).not.toHaveTextContent('cheapest')
    // The sidebar's reading of each session; a removed copy says so and offers no review.
    expect(cards[2]).toHaveTextContent('waiting on you')
    expect(cards[2]).toHaveTextContent('its copy has been removed')
    expect(within(cards[2]!).queryByRole('button', { name: 'Review changes' })).toBeNull()

    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith(res.attempts[1])
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Review changes' }))
    expect(onReview).toHaveBeenCalledWith(res.attempts[0])
  })

  it('says what failed to load, and closes on Esc', async () => {
    m.attempts.mockRejectedValue(new Error('no such group of attempts'))
    const onClose = vi.fn()
    render(<AttemptsCompare group="nope" onClose={onClose} onOpen={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('no such group')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('times a running attempt to now and an ended one to its last work', () => {
    expect(attemptDuration(view(1), 121_000)).toBe(120_000)
    expect(attemptDuration(view(1, {}, { status: 'ended', worked_at: 31_000 }), 999_000)).toBe(30_000)
    expect(attemptState(view(1, {}, { status: 'ended', exit_code: 2 }), 'working').word).toBe('exited 2')
    expect(attemptState(view(1), 'idle').word).toBe('idle')
    expect(attemptState(view(1), 'looping').word).toBe('looping')
    // A session the sidebar does not list is only said to be running.
    expect(attemptState(view(1)).word).toBe('running')
  })

  it('labels a session that is one of several attempts', () => {
    expect(attemptLabel({ attempt: 2, attempts: 3 })).toBe('attempt 2/3')
    expect(attemptLabel({ attempt: 1, attempts: 1 })).toBe('')
    expect(attemptLabel({})).toBe('')
    const s = { ...view(2).session, title: 'Fix the login bug', attempt: 2, attempts: 3 } as Parameters<typeof sessionTitle>[0]
    expect(sessionTitle(s)).toBe('attempt 2/3 · Fix the login bug')
  })
})
