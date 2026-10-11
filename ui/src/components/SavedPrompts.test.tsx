import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const m = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, savedPrompts: m.list, addSavedPrompt: m.add, updateSavedPrompt: m.update, removeSavedPrompt: m.remove } }
})
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, list: async () => [{ id: '7', name: 'alpha', root: '/work/alpha', kind: 'repo' }] } }
})

import { TerminalKeys } from './TerminalKeys'
import { SavedPromptsEditor } from './SavedPromptsSetting'
import { resetSaved, type SavedPrompt } from '@/lib/saved'

const row = (over: Partial<SavedPrompt>): SavedPrompt => ({ id: 1, kind: 'prompt', name: 'n', text: 't', sort: 0, created_at: 0, updated_at: 0, ...over })

describe('saved prompts', () => {
  afterEach(() => {
    cleanup()
    resetSaved()
    vi.clearAllMocks()
  })

  it('shows a session’s prompts as chips; a tap fills the field and does not send', async () => {
    m.list.mockResolvedValue({ items: [row({ id: 1, name: 'Fix tests', text: 'Run the tests and fix what fails.' }), row({ id: 2, kind: 'command', name: 'Dev', text: 'pnpm dev' })], max: 200 })
    const send = vi.fn()
    render(<TerminalKeys send={send} sessionId="s1" chips />)
    await waitFor(() => expect(m.list).toHaveBeenCalledWith('s1'))
    const group = await screen.findByRole('group', { name: 'Saved prompts' })
    // A command is not a chip: the phone does not run shells.
    expect(within(group).queryByText('Dev')).toBeNull()
    fireEvent.click(within(group).getByRole('button', { name: 'Fix tests' }))
    expect((screen.getByLabelText('Type to the session') as HTMLTextAreaElement).value).toBe('Run the tests and fix what fails.')
    expect(send).not.toHaveBeenCalled()
  })

  it('draws no chip row without saved prompts or without asking for one', async () => {
    m.list.mockResolvedValue({ items: [], max: 200 })
    render(<TerminalKeys send={vi.fn()} sessionId="s1" chips />)
    await waitFor(() => expect(m.list).toHaveBeenCalled())
    expect(screen.queryByRole('group', { name: 'Saved prompts' })).toBeNull()
    cleanup()
    m.list.mockClear()
    render(<TerminalKeys send={vi.fn()} sessionId="s1" />)
    expect(m.list).not.toHaveBeenCalled()
  })

  it('adds, edits and deletes in Settings, and says what the daemon refused', async () => {
    m.list.mockResolvedValue({ items: [], max: 200 })
    const added = row({ id: 5, kind: 'command', name: 'Dev server', text: 'pnpm dev', project_id: 7, project_name: 'alpha' })
    m.add.mockResolvedValueOnce({ item: added })
    render(<SavedPromptsEditor />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind' }), { target: { value: 'command' } })
    fireEvent.change(screen.getByPlaceholderText('Dev server'), { target: { value: 'Dev server' } })
    await screen.findByRole('option', { name: 'alpha' })
    fireEvent.change(screen.getByRole('combobox', { name: 'For' }), { target: { value: '7' } })
    fireEvent.change(screen.getByPlaceholderText('pnpm dev'), { target: { value: ' pnpm dev ' } })
    // The list is read again after a save, for the daemon's order.
    m.list.mockResolvedValue({ items: [added], max: 200 })
    fireEvent.click(screen.getByRole('button', { name: 'Add command' }))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith({ kind: 'command', name: 'Dev server', text: 'pnpm dev', project_id: 7 }))
    const list = await screen.findByRole('list', { name: 'Saved prompts and commands' })
    expect(list).toHaveTextContent('Dev server')
    expect(list).toHaveTextContent('alpha')

    // An edit the daemon refuses says why.
    fireEvent.click(within(list).getByRole('button', { name: 'Edit' }))
    m.update.mockRejectedValueOnce(new Error('the command is longer than 1024 bytes'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('longer than 1024 bytes')

    m.remove.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Dev server' }))
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith(5))
  })
})
