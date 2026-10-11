import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CopiesSheet } from './CopiesSheet'
import { blockedReason, isSafePick, lossOf, shortPath, sizeText, type CopiesView, type ProjectCopy } from '@/lib/copies'

const m = vi.hoisted(() => ({ copies: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, copies: m.copies, removeCopies: m.remove } }
})

const base: ProjectCopy = { path: '', caprock: true, merged: false, unpushed: 0, dirty: false, changed: 0, live: [], size: 1000 }
const main: ProjectCopy = { ...base, path: '/r', main: true, caprock: false, branch: 'main', size: null }
const clean: ProjectCopy = { ...base, path: '/r/.caprock-worktrees/done', branch: 'done', merged: true, size: 2_000_000 }
const dirty: ProjectCopy = { ...base, path: '/r/.caprock-worktrees/wip', branch: 'wip', dirty: true, changed: 3, unpushed: 2 }
const live: ProjectCopy = { ...base, path: '/r/.caprock-worktrees/busy', branch: 'busy', live: ['the session "fix"'] }
const hand: ProjectCopy = { ...base, path: '/elsewhere', branch: 'mine', caprock: false }
const measuring: ProjectCopy = { ...base, path: '/r/.caprock-worktrees/new', branch: 'new', size: null }

const view = (copies: ProjectCopy[], extra: Partial<CopiesView> = {}): CopiesView => ({ copies, has_remote: true, total: 3_000_000, default_branch: 'main', ...extra })

beforeEach(() => {
  m.copies.mockReset().mockResolvedValue(view([main, clean, dirty, live, hand, measuring], { pending: true }))
  m.remove.mockReset()
})

describe('copies helpers', () => {
  it('blocks the main checkout, a hand-made copy, a locked one and a live one', () => {
    expect(blockedReason(main)).toMatch(/never removed/)
    expect(blockedReason(hand)).toMatch(/outside Caprock/)
    expect(blockedReason({ ...clean, locked: true })).toMatch(/Locked/)
    expect(blockedReason(live)).toMatch(/^The session "fix" running in it/)
    expect(blockedReason(clean)).toBeNull()
  })

  it('names what would be lost', () => {
    expect(lossOf(dirty, true)).toEqual(['3 uncommitted changes (deleted with the folder)', '2 commits on no remote (kept on branch wip)'])
    expect(lossOf(dirty, false)).toEqual(['3 uncommitted changes (deleted with the folder)'])
    expect(lossOf({ ...clean, detached: true, orphaned: 1 }, true)).toEqual(['1 commit on no branch (left only in the reflog)'])
    expect(lossOf(clean, true)).toEqual([])
  })

  it('shows sizes, floors and the wait', () => {
    expect(sizeText(measuring)).toBe('…')
    expect(sizeText(main)).toBe('—')
    expect(sizeText(clean)).toBe('2.0MB')
    expect(sizeText({ ...clean, size_capped: true })).toBe('≥ 2.0MB')
    expect(isSafePick(clean, true)).toBe(true)
    expect(isSafePick(dirty, true)).toBe(false)
  })

  it('shows a path inside the main checkout relative to it, on either separator', () => {
    expect(shortPath('/r/.caprock-worktrees/done', '/r')).toBe('.caprock-worktrees/done')
    expect(shortPath('C:\\src\\app\\.caprock-worktrees\\x', 'C:\\src\\app')).toBe('.caprock-worktrees\\x')
    expect(shortPath('/r', '/r')).toBe('/r')
    expect(shortPath('/elsewhere', '/r')).toBe('/elsewhere')
    expect(shortPath('/rx/y', '/r')).toBe('/rx/y')
  })
})

describe('copies sheet', () => {
  it('lists every copy with its total, and disables the ones it may not remove', async () => {
    render(<CopiesSheet projectId="7" name="api" onClose={() => {}} />)
    const list = await screen.findByRole('list', { name: 'Copies' })
    expect(within(list).getAllByRole('checkbox')).toHaveLength(6)
    expect((screen.getByLabelText(/^main/) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(/^mine/) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText(/^busy/) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/running in it/)).toBeTruthy()
    expect(screen.getByText('5 copies')).toBeTruthy()
    expect(screen.getByText('3.0MB so far')).toBeTruthy()
    expect(screen.getByText('…')).toBeTruthy()
  })

  it('removes a clean copy at once, with its merged branch when asked', async () => {
    m.remove.mockResolvedValue([{ path: clean.path, removed: true, branch_deleted: 'done' }])
    const changed = vi.fn()
    render(<CopiesSheet projectId="7" name="api" onClose={() => {}} onChanged={changed} />)
    fireEvent.click(await screen.findByLabelText(/^done/))
    fireEvent.click(screen.getByLabelText('Also delete merged branches'))
    fireEvent.click(screen.getByRole('button', { name: /^Remove 1/ }))
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith('7', [{ path: clean.path, force: false }], true))
    expect(await screen.findByText(/Removed 1 copy, 2.0MB freed; deleted branch done/)).toBeTruthy()
    expect(changed).toHaveBeenCalled()
  })

  it('asks again, listing the loss, before removing a copy with work in it', async () => {
    m.remove.mockResolvedValue([{ path: clean.path, removed: true }, { path: dirty.path, removed: true }])
    render(<CopiesSheet projectId="7" name="api" onClose={() => {}} />)
    fireEvent.click(await screen.findByLabelText(/^done/))
    fireEvent.click(screen.getByLabelText(/^wip/))
    fireEvent.click(screen.getByRole('button', { name: /^Remove 2/ }))
    expect(m.remove).not.toHaveBeenCalled()
    const ask = screen.getByRole('group', { name: 'Confirm what would be lost' })
    expect(within(ask).getByText('3 uncommitted changes (deleted with the folder)')).toBeTruthy()
    expect(within(ask).getByText('2 commits on no remote (kept on branch wip)')).toBeTruthy()
    expect(within(ask).getByText('The other copy loses nothing.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith('7', [{ path: clean.path, force: false }, { path: dirty.path, force: true }], false))
  })

  it('picks the merged and clean ones in one go', async () => {
    render(<CopiesSheet projectId="7" name="api" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select merged and clean (1)' }))
    expect((screen.getByLabelText(/^done/) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^wip/) as HTMLInputElement).checked).toBe(false)
  })
})
