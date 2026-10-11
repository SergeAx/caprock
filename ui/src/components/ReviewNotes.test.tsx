/**
 * Review notes in the Changes view: a click on a line number opens a note
 * there, a shift-click covers a range, Enter keeps it under its line, and the
 * bar sends every note as one prompt — typed into the running session
 * Caprock started there, never while it waits on a permission prompt, or
 * handed to a new agent when there is none — and then clears them.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Changes, FilePatch } from '@/lib/changes'
import { resetNotesCache } from '@/lib/reviewNotes'
import { ChangesView } from './ChangesView'
import type { HandoffTarget } from './AgentHandoff'
import { wrappedLines } from './ReviewNotes'

function status(): Changes {
  return {
    project_id: 7, worktree: 'wt', path: '/r/wt', branch: 'feat/x', ahead: 0, behind: 0, remote: 'origin', published: true,
    upstream: 'origin/feat/x', staged: [], conflicted: [], token: 't1', at: 1,
    unstaged: [{ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
  }
}

const PATCH: FilePatch = {
  path: 'src/a.ts', staged: false, status: 'modified', bytes: 60, token: 'p',
  patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n ctx\n-gone\n+came\n+more\n',
}

interface Call { method: string; url: string; body?: unknown }
let calls: Call[] = []
let waiting = false

beforeEach(() => {
  localStorage.clear()
  resetNotesCache()
  calls = []
  waiting = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined }
    calls.push(c)
    let body: unknown = status()
    let code = 200
    if (url.includes('/changes/diff')) body = PATCH
    else if (url.includes('/permission')) body = { permission: waiting ? { tool: 'Bash' } : null }
    else if (url.includes('/input')) { body = null; code = 204 }
    else if (url.includes('/github')) body = { reason: 'no_remote' }
    return code === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const view = (handoff?: HandoffTarget) => render(
  <ChangesView target={{ projectId: '7', worktree: 'wt' }} title="repo · feat/x" onClose={() => {}} handoff={handoff} />,
)
const inputs = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/v1/agents/s9/input')).map((c) => (c.body as { data: string }).data)

async function addNote(text: string, range = false) {
  fireEvent.click(await screen.findByRole('button', { name: 'Note on line 2' }))
  if (range) fireEvent.click(screen.getByRole('button', { name: 'Note on line 3' }), { shiftKey: true })
  const box = await screen.findByRole('textbox', { name: range ? 'Note on lines 2–3' : 'Note on line 2' })
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

describe('review notes', () => {
  it('adds a note on a line, shows it under the line, and keeps it for the worktree', async () => {
    view()
    await screen.findByText('came')
    await addNote('Name this better')
    expect(await screen.findByText('Name this better')).toBeTruthy()
    expect(screen.getByText('src/a.ts:2')).toBeTruthy()
    expect(screen.getByRole('button', { name: /1 note/ })).toBeTruthy()
    const kept = JSON.parse(localStorage.getItem('caprock.review.7:wt') ?? '[]')
    expect(kept).toHaveLength(1)
    expect(kept[0].quote).toEqual(['+ came'])
    // Back after a tab switch: the view is drawn again and the note is there.
    cleanup()
    resetNotesCache()
    view()
    expect(await screen.findByText('Name this better')).toBeTruthy()
  })

  it('covers a range with a shift-click, and edits and deletes a note', async () => {
    view()
    await screen.findByText('came')
    await addNote('Both lines', true)
    expect(await screen.findByText('src/a.ts:2-3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const box = await screen.findByRole('textbox', { name: 'Note on lines 2–3' })
    fireEvent.change(box, { target: { value: 'Both lines, reworded' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Both lines, reworded')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete the note on src/a.ts:2-3' }))
    await waitFor(() => expect(screen.queryByText('Both lines, reworded')).toBeNull())
    expect(localStorage.getItem('caprock.review.7:wt')).toBeNull()
  })

  it('Esc in the note box cancels it without closing the view', async () => {
    const onClose = vi.fn()
    render(<ChangesView target={{ projectId: '7', worktree: 'wt' }} title="repo · feat/x" onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Note on line 2' }))
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Note on line 2' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Note on line 2' })).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('types the notes into the running session as one prompt, then clears them', async () => {
    const openSession = vi.fn()
    view({ session: { id: 's9', title: 'Fix the parser' }, startAgent: vi.fn(), openSession })
    await screen.findByText('came')
    await addNote('Handle the empty case')
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))
    await waitFor(() => expect(inputs()).toHaveLength(2))
    const [text, enter] = inputs()
    expect(text).toContain('src/a.ts:2')
    expect(text).toContain('+ came')
    expect(text).toContain('Handle the empty case')
    expect(text).toContain('in feat/x')
    expect(text).not.toContain('\n')
    expect(text).toContain('\x1b\r')
    expect(enter).toBe('\r')
    expect(await screen.findByText(/Sent to/)).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Handle the empty case')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(openSession).toHaveBeenCalledWith('s9')
  })

  it('types nothing while the session waits on a permission prompt', async () => {
    waiting = true
    view({ session: { id: 's9', title: 'Fix the parser' } })
    await screen.findByText('came')
    await addNote('Later')
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))
    expect(await screen.findByText(/waiting on a permission prompt/)).toBeTruthy()
    expect(inputs()).toHaveLength(0)
    expect(screen.getByText('Later')).toBeTruthy()
  })

  it('with no session Caprock can type into, opens a new agent with the prompt and clears once it starts', async () => {
    const startAgent = vi.fn()
    view({ startAgent })
    await screen.findByText('came')
    await addNote('Start here')
    fireEvent.click(screen.getByRole('button', { name: 'New agent with the notes…' }))
    expect(startAgent).toHaveBeenCalledTimes(1)
    const [prompt, started] = startAgent.mock.calls[0]! as [string, () => void]
    expect(prompt).toContain('1. src/a.ts:2')
    expect(screen.getByText('Start here')).toBeTruthy()
    started()
    await waitFor(() => expect(screen.queryByText('Start here')).toBeNull())
  })
})

describe('a note’s height', () => {
  it('wraps at spaces as the browser does, breaking only a word longer than a row', () => {
    expect(wrappedLines('', 10)).toBe(1)
    expect(wrappedLines('short', 10)).toBe(1)
    expect(wrappedLines('aaaa bbbb cccc', 10)).toBe(2)
    expect(wrappedLines('aaaa bbbbb', 10)).toBe(1)
    expect(wrappedLines('aaaa bbbbbb', 10)).toBe(2)
    expect(wrappedLines('x'.repeat(25), 10)).toBe(3)
    expect(wrappedLines('ab ' + 'x'.repeat(25), 10)).toBe(4)
  })
})
