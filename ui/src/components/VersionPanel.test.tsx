import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@/lib/api'
import { VersionPanel, notesPreview } from './VersionPanel'

afterEach(() => vi.unstubAllGlobals())

const base: UpdateStatus = { enabled: true, current: '0.104.0', update_available: false }

describe('the version panel', () => {
  it('says an update is out, when it last looked, and what changed', () => {
    const now = Date.now()
    render(<VersionPanel shown="0.104.0" title="" onStatus={() => {}}
      status={{ ...base, latest: 'v0.105.0', update_available: true, checked_at: now - 37 * 60_000, notes: '## Added\n- **The session deck.** Under the terminal.', notes_for: 'v0.105.0' }} />)
    fireEvent.click(screen.getByText('0.104.0'))
    const dlg = screen.getByRole('dialog', { name: 'Caprock version' })
    expect(dlg.textContent).toMatch(/0\.105\.0 is available/)
    expect(dlg.querySelector('[data-checked]')?.textContent).toMatch(/Last checked 37m ago/)
    expect(dlg.querySelector('[data-notes]')?.textContent).toMatch(/The session deck\. Under the terminal\./)
  })

  it('says up to date when the latest is the one running', () => {
    render(<VersionPanel shown="0.105.0" title="" onStatus={() => {}} status={{ ...base, current: '0.105.0', latest: '0.105.0', checked_at: Date.now() }} />)
    fireEvent.click(screen.getByText('0.105.0'))
    expect(screen.getByRole('dialog').textContent).toMatch(/up to date/)
  })

  it('asks the daemon to look on Check now', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...base, latest: '0.105.0', update_available: true, checked_at: Date.now() }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const onStatus = vi.fn()
    render(<VersionPanel shown="0.104.0" title="" onStatus={onStatus} status={base} />)
    fireEvent.click(screen.getByText('0.104.0'))
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(onStatus).toHaveBeenCalled())
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/v1\/update\/check/)
  })

  it('previews the first lines of the notes, plain', () => {
    expect(notesPreview('## Added\n\n- **A.** one\n- B', 2)).toEqual({ text: 'Added\n- A. one', more: true })
  })
})
