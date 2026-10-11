import { describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ input: vi.fn(async () => undefined) }))
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>()
  return { ...actual, api: { ...actual.api, agentInput: m.input } }
})

import { dirWithin, draftProblem, savedFor, sendPrompt, SAVED_COMMAND_BYTES, SAVED_NAME_MAX, type SavedPrompt } from './saved'

const row = (over: Partial<SavedPrompt>): SavedPrompt => ({ id: 1, kind: 'prompt', name: 'n', text: 't', sort: 0, created_at: 0, updated_at: 0, ...over })

describe('saved prompts', () => {
  it('says what the daemon would refuse before a save', () => {
    expect(draftProblem({ kind: 'prompt', name: ' ', text: 'x', project_id: 0 })).toMatch(/name/)
    expect(draftProblem({ kind: 'prompt', name: 'n'.repeat(SAVED_NAME_MAX + 1), text: 'x', project_id: 0 })).toMatch(/longer/)
    expect(draftProblem({ kind: 'prompt', name: 'a', text: '  ', project_id: 0 })).toBe('The prompt is empty.')
    expect(draftProblem({ kind: 'command', name: 'a', text: 'make\nmake test', project_id: 0 })).toMatch(/one line/)
    expect(draftProblem({ kind: 'command', name: 'a', text: 'x'.repeat(SAVED_COMMAND_BYTES + 1), project_id: 0 })).toMatch(/bytes/)
    // A prompt may run over several lines; a trailing newline is trimmed, not refused.
    expect(draftProblem({ kind: 'prompt', name: 'Fix', text: 'Run the tests.\nFix what fails.', project_id: 0 })).toBe('')
    expect(draftProblem({ kind: 'command', name: 'Dev', text: 'pnpm dev\n', project_id: 0 })).toBe('')
  })

  it('matches a folder to its project on segment boundaries, either separator', () => {
    expect(dirWithin('/work/alpha', '/work/alpha')).toBe(true)
    expect(dirWithin('/work/alpha/.caprock-worktrees/fix', '/work/alpha/')).toBe(true)
    expect(dirWithin('/work/alphabet', '/work/alpha')).toBe(false)
    expect(dirWithin('C:\\work\\alpha\\src', 'C:/work/alpha')).toBe(true)
    expect(dirWithin('', '/work')).toBe(false)
  })

  it('keeps the ones for every project and the ones of the project in front', () => {
    const items = [
      row({ id: 1, name: 'everywhere' }),
      row({ id: 2, name: 'alpha', project_id: 7, project_root: '/work/alpha' }),
      row({ id: 3, name: 'beta', project_id: 8, project_root: '/work/beta' }),
    ]
    expect(savedFor(items, { dir: '/work/alpha/.caprock-worktrees/x' }).map((v) => v.name)).toEqual(['everywhere', 'alpha'])
    expect(savedFor(items, { projectId: '8' }).map((v) => v.name)).toEqual(['everywhere', 'beta'])
    expect(savedFor(items, {}).map((v) => v.name)).toEqual(['everywhere'])
  })

  it('types a prompt as the message field does: newlines as ESC CR, then Enter on its own', async () => {
    await sendPrompt('s1', 'one\ntwo')
    expect(m.input.mock.calls).toEqual([['s1', 'one\x1b\rtwo'], ['s1', '\r']])
  })
})
