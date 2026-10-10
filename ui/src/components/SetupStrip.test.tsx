/**
 * The setup strip ticks each item from the daemon, retires an item for good
 * on "Not needed", hides for a week on ×, and is gone once nothing is left.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupStrip } from './SetupStrip'
import { api, type PairState, type TelegramStatus } from '@/lib/api'
import { resetPrompts } from '@/lib/prompts'
import { resetNudgeSlots } from '@/lib/nudges'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function state(phones: number, telegram: boolean) {
  vi.spyOn(api, 'pairState').mockResolvedValue({
    enabled: false,
    devices: Array.from({ length: phones }, (_, i) => ({ id: `d${i}`, name: 'Phone', paired_at: NOW, last_seen: NOW, role: 'viewer' })),
  } as unknown as PairState)
  vi.spyOn(api, 'telegram').mockResolvedValue({ bot_set: telegram, chat_set: telegram, polling: false } as TelegramStatus)
}

const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => { resetPrompts(); resetNudgeSlots(); vi.restoreAllMocks(); location.hash = '' })

describe('SetupStrip', () => {
  it('offers both when neither is connected, and opens Settings at the section', async () => {
    state(0, false)
    render(<SetupStrip now={NOW} />)
    expect(await screen.findByText('Open on your phone')).toBeTruthy()
    expect(screen.getByText('Connect Telegram')).toBeTruthy()
    expect(document.body.textContent).toContain('0 of 2')
    fireEvent.click(screen.getByText('Connect Telegram'))
    expect(location.hash).toBe('#/settings')
  })

  it('ticks what is connected and keeps offering the rest', async () => {
    state(1, false)
    render(<SetupStrip now={NOW} />)
    expect(await screen.findByText(/Phone connected/)).toBeTruthy()
    expect(document.body.textContent).toContain('1 of 2')
    expect(screen.getByText('Connect Telegram')).toBeTruthy()
  })

  it('is gone once both are connected', async () => {
    state(2, true)
    const { container } = render(<SetupStrip now={NOW} />)
    await settle()
    expect(container.textContent).toBe('')
  })

  it('"Not needed" retires one item for good', async () => {
    state(0, false)
    const { rerender } = render(<SetupStrip now={NOW} />)
    fireEvent.click((await screen.findAllByText('Not needed'))[1]!)
    expect(screen.queryByText('Connect Telegram')).toBeNull()
    expect(screen.getByText('Open on your phone')).toBeTruthy()
    rerender(<SetupStrip now={NOW + 365 * DAY} />)
    expect(screen.queryByText('Connect Telegram')).toBeNull()
  })

  it('× hides it for a week', async () => {
    state(0, false)
    const { container, rerender } = render(<SetupStrip now={NOW} />)
    fireEvent.click(await screen.findByLabelText('Hide for a week'))
    expect(container.textContent).toBe('')
    rerender(<SetupStrip now={NOW + 8 * DAY} />)
    expect(await screen.findByText('Open on your phone')).toBeTruthy()
  })
})
