/**
 * "Fix with agent" where the Changes view shows a failure: a commit or push a
 * hook refused, files in conflict, and the pull request's failing checks or
 * conflicts. The output goes to the running session Caprock started in the
 * worktree, or to a new agent started there; nothing else is offered.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Changes, FilePatch } from '@/lib/changes'
import type { PullRequest } from '@/lib/github'
import { checksFixPrompt, conflictsFixPrompt, hookFixPrompt, opName, prConflictsFixPrompt } from '@/lib/fixPrompts'
import { ChangesView } from './ChangesView'
import { PRStatus } from './PullRequest'
import type { HandoffTarget } from './AgentHandoff'

function status(over: Partial<Changes> = {}): Changes {
  return {
    project_id: 7, worktree: 'wt', path: '/r/wt', branch: 'feat/x', head: 'abc1234', ahead: 1, behind: 0, remote: 'origin', published: true,
    upstream: 'origin/feat/x', staged: [], conflicted: [], token: 't1', at: 1,
    unstaged: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
    ...over,
  }
}

const PATCH: FilePatch = { path: 'src/a.ts', staged: false, status: 'modified', bytes: 40, token: 'p', patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n ctx\n+new\n' }

interface Call { method: string; url: string; body?: unknown }
let calls: Call[] = []
let handler: (c: Call) => { status?: number; body: unknown } | undefined

beforeEach(() => {
  localStorage.clear()
  calls = []
  handler = () => undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined }
    calls.push(c)
    const r = handler(c) ?? (
      url.includes('/changes/diff') ? { body: PATCH }
        : url.includes('/permission') ? { body: { permission: null } }
          : url.includes('/input') ? { status: 204, body: null }
            : url.includes('/github') ? { body: { reason: 'no_remote' } }
              : { body: status() }
    )
    return r.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const LIVE: HandoffTarget = { session: { id: 's9', title: 'Fix the parser' }, startAgent: vi.fn(), openSession: vi.fn() }
const view = (handoff?: HandoffTarget) => render(<ChangesView target={{ projectId: '7', worktree: 'wt' }} title="repo · feat/x" onClose={() => {}} handoff={handoff} />)
const typed = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/v1/agents/s9/input')).map((c) => (c.body as { data: string }).data)

describe('Fix with agent', () => {
  it('sends a refused commit with what the hook printed to the running session', async () => {
    handler = (c) => (c.url.includes('/changes/commit') ? { status: 422, body: { error: 'the pre-commit hook refused it', kind: 'hook', output: '\x1b[31mlint: 3 problems in src/a.ts\x1b[0m' } } : undefined)
    view(LIVE)
    await screen.findByText('new')
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'try' } })
    fireEvent.keyDown(screen.getByLabelText('Commit message'), { key: 'Enter', metaKey: true })
    expect(await screen.findByText(/pre-commit hook refused it/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fix with agent' }))
    await waitFor(() => expect(typed()).toHaveLength(2))
    expect(typed()[0]).toContain('This failed: committing in this worktree on feat/x')
    expect(typed()[0]).toContain('lint: 3 problems in src/a.ts')
    expect(typed()[0]).not.toContain('\x1b[31m')
    expect(typed()[1]).toBe('\r')
    expect(await screen.findByText(/Sent to/)).toBeTruthy()
  })

  it('offers no fix for a failure that is not a hook’s', async () => {
    handler = (c) => (c.url.includes('/changes/commit') ? { status: 422, body: { error: 'nothing to commit', kind: 'state' } } : undefined)
    view(LIVE)
    await screen.findByText('new')
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'try' } })
    fireEvent.keyDown(screen.getByLabelText('Commit message'), { key: 'Enter', metaKey: true })
    expect(await screen.findByText(/nothing to commit/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Fix with/ })).toBeNull()
  })

  it('hands a push a pre-push hook refused to a new agent when none is running', async () => {
    const startAgent = vi.fn()
    handler = (c) => (c.url.includes('/changes/push') ? { status: 422, body: { error: 'the pre-push hook refused it', kind: 'hook', output: 'tests failed: 2' } } : undefined)
    view({ startAgent })
    await screen.findByText('new')
    fireEvent.click(screen.getByRole('button', { name: 'Push 1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Fix with a new agent…' }))
    expect(startAgent).toHaveBeenCalledTimes(1)
    expect(startAgent.mock.calls[0]![0]).toContain('pushing in this worktree')
    expect(startAgent.mock.calls[0]![0]).toContain('tests failed: 2')
  })

  it('sends the files in conflict, and names the operation under way', async () => {
    handler = (c) => (c.url.includes('/changes?') || c.url.endsWith('/changes') ? {
      body: status({ state: 'merging', unstaged: [], conflicted: [{ path: 'a.go', status: 'conflicted', additions: 0, deletions: 0 }, { path: 'b.go', status: 'conflicted', additions: 0, deletions: 0 }] }),
    } : undefined)
    view(LIVE)
    expect(await screen.findByText(/A merge is under way in this worktree; finish or abort it in a terminal. 2 files are in conflict./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fix with agent' }))
    await waitFor(() => expect(typed()).toHaveLength(2))
    expect(typed()[0]).toContain('a merge left 2 files in conflict')
    expect(typed()[0]).toContain('- a.go')
    expect(typed()[0]).toContain('Do not commit, continue or abort the merge')
  })

  it('offers nothing without a place to send it', async () => {
    handler = (c) => (c.url.includes('/changes/commit') ? { status: 422, body: { error: 'the pre-commit hook refused it', kind: 'hook', output: 'x' } } : undefined)
    view()
    await screen.findByText('new')
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'try' } })
    fireEvent.keyDown(screen.getByLabelText('Commit message'), { key: 'Enter', metaKey: true })
    expect(await screen.findByText(/pre-commit hook refused it/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Fix with/ })).toBeNull()
  })
})

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    project_id: 7, worktree: 'wt', branch: 'feat/x', repo: 'ada/caprock', number: 12, url: 'https://github.com/ada/caprock/pull/12',
    title: 'Add the thing', state: 'open', draft: false, base: 'main', head_sha: 'abc', mergeable: true, mergeable_state: 'unstable',
    review: '', reviews: [],
    checks: { state: 'fail', passed: 1, failed: 1, pending: 0, items: [{ name: 'lint', state: 'pass' }, { name: 'build', state: 'fail', url: 'https://ci/1' }] },
    at: Date.now(), ...over,
  }
}

describe('Fix with agent on a pull request', () => {
  it('sends the failing checks by name and link', async () => {
    render(<PRStatus pr={pr()} fix={LIVE} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fix with agent' }))
    await waitFor(() => expect(typed()).toHaveLength(2))
    expect(typed()[0]).toContain('a check on pull request #12 on feat/x')
    expect(typed()[0]).toContain('- build: https://ci/1')
    expect(typed()[0]).not.toContain('lint')
  })

  it('offers a fix for conflicts with the base, and nothing when all is green or the app is not the caller', () => {
    const { unmount } = render(<PRStatus pr={pr({ checks: { state: 'pass', passed: 1, failed: 0, pending: 0, items: [{ name: 'lint', state: 'pass' }] }, mergeable: false, mergeable_state: 'dirty' })} fix={LIVE} />)
    expect(screen.getAllByRole('button', { name: 'Fix with agent' })).toHaveLength(1)
    unmount()
    const green = render(<PRStatus pr={pr({ checks: { state: 'pass', passed: 1, failed: 0, pending: 0, items: [] } })} fix={LIVE} />)
    expect(screen.queryByRole('button', { name: /Fix with/ })).toBeNull()
    green.unmount()
    render(<PRStatus pr={pr()} />)
    expect(screen.queryByRole('button', { name: /Fix with/ })).toBeNull()
  })
})

describe('fix prompts', () => {
  it('names the operation as a noun', () => {
    expect(opName('merging')).toBe('merge')
    expect(opName('rebasing')).toBe('rebase')
    expect(opName('cherry-picking')).toBe('cherry-pick')
    expect(opName('reverting')).toBe('revert')
  })

  it('keeps the tail of a long hook output and says so', () => {
    const out = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
    const p = hookFixPrompt('commit', 'the pre-commit hook refused it.', out)
    expect(p).toContain('the pre-commit hook refused it. Find the cause')
    expect(p).toContain('(the end of it)')
    expect(p).toContain('[280 earlier lines cut]')
    expect(p).toContain('line 399')
    expect(p).not.toContain('line 279\n')
    expect(hookFixPrompt('push', 'refused', undefined)).not.toContain('printed')
  })

  it('lists conflicts without an operation, and a pull request’s conflicts with its base', () => {
    expect(conflictsFixPrompt(['a'], undefined)).toContain('git left a file in conflict')
    expect(conflictsFixPrompt(['a'], undefined)).toContain('Do not commit; I will.')
    expect(prConflictsFixPrompt({ number: 3, url: 'u', base: 'main' })).toContain('merge its main into this branch')
    expect(checksFixPrompt({ number: 3, url: 'u' }, [{ name: 'a', state: 'fail' }, { name: 'b', state: 'fail' }])).toContain('2 checks on pull request #3')
  })
})
