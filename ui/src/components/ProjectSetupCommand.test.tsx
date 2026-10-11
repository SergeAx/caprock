import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSetupCommand } from './ProjectSetupCommand'
import type { Project } from '@/lib/projects'

const m = vi.hoisted(() => ({ patch: vi.fn(), paired: false }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, patch: m.patch } }
})
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, isPairedDevice: () => m.paired }
})

const project: Project = { id: '7', root: '/r', name: 'api', kind: 'repo', defaults: { system_prompt: 'Use make.' } }

beforeEach(() => {
  m.paired = false
  m.patch.mockReset().mockImplementation(async (id: string, p: Partial<Project>) => ({ ...project, id, ...p }))
})

describe('project setup command', () => {
  it('says none is set, and names .worktreeinclude only in the tooltip', () => {
    render(<ProjectSetupCommand project={project} />)
    expect(screen.getByText(/None\./).getAttribute('title')).toMatch(/\.worktreeinclude/)
    expect(screen.queryByText(/worktree/i)).toBeNull()
  })

  it('saves a command keeping the other defaults, and shows it', async () => {
    render(<ProjectSetupCommand project={project} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Setup command' }), { target: { value: '  npm install  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('7', { defaults: { system_prompt: 'Use make.', setup_command: 'npm install' } }))
    expect(await screen.findByText('npm install')).toBeTruthy()
  })

  it('Enter saves without bubbling to the sheet', async () => {
    const outer = vi.fn()
    render(<div onKeyDown={outer}><ProjectSetupCommand project={project} /></div>)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const field = screen.getByRole('textbox', { name: 'Setup command' })
    fireEvent.change(field, { target: { value: 'uv sync' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(m.patch).toHaveBeenCalled())
    expect(outer).not.toHaveBeenCalled()
  })

  it('clearing it removes only the command', async () => {
    render(<ProjectSetupCommand project={{ ...project, defaults: { system_prompt: 'x', setup_command: 'npm ci' } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Setup command' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(m.patch).toHaveBeenCalledWith('7', { defaults: { system_prompt: 'x' } }))
  })

  it('is read-only on a paired device', () => {
    m.paired = true
    render(<ProjectSetupCommand project={{ ...project, defaults: { setup_command: 'npm ci' } }} />)
    expect(screen.getByText('npm ci')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})
