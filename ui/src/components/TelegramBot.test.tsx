/**
 * The guided Telegram setup (ADR-047): a token checked with Telegram, then a
 * pairing code, then the paired chat by name. The token never comes back.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TelegramBotFields } from './TelegramBot'
import type { TelegramStatus } from '@/lib/api'

const tg = vi.hoisted(() => ({
  state: { bot_set: false, chat_set: false, polling: false } as TelegramStatus,
  tokens: [] as string[],
  refuse: '',
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      telegram: async () => tg.state,
      telegramToken: async (token: string) => {
        tg.tokens.push(token)
        if (tg.refuse) throw new Error(tg.refuse)
        tg.state = { bot_set: true, bot_username: 'my_bot', token_masked: '••••••x9Zq', chat_set: false, polling: false }
        return tg.state
      },
      telegramPair: async () => {
        tg.state = { ...tg.state, pairing: { code: '482913', link: 'https://t.me/my_bot?start=482913', expires_ms: Date.now() + 600_000 } }
        return tg.state
      },
    },
  }
})

describe('TelegramBotFields', () => {
  it('shows Telegram’s refusal of a token and keeps nothing', async () => {
    tg.refuse = 'Telegram does not recognise this token. Copy it again from @BotFather'
    tg.state = { bot_set: false, chat_set: false, polling: false }
    render(<TelegramBotFields onSaved={() => {}} />)
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: '1:bad' } })
    fireEvent.click(screen.getByText('Check and save'))
    await waitFor(() => expect(screen.getByText(/does not recognise this token/)).toBeInTheDocument())
    expect(tg.tokens).toEqual(['1:bad'])
  })

  it('goes from a checked token straight to a pairing code with a one-tap link', async () => {
    tg.refuse = ''
    tg.tokens = []
    tg.state = { bot_set: false, chat_set: false, polling: false }
    const saved = vi.fn()
    render(<TelegramBotFields onSaved={saved} />)
    fireEvent.change(await screen.findByLabelText('Bot token'), { target: { value: ' 123:ok ' } })
    fireEvent.click(screen.getByText('Check and save'))
    expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('482913')
    expect(screen.getByText('Open @my_bot and send it').closest('a')).toHaveAttribute('href', 'https://t.me/my_bot?start=482913')
    expect(screen.getByText('/start 482913')).toBeInTheDocument()
    expect(tg.tokens).toEqual(['123:ok'])
    expect(saved).toHaveBeenCalled()
    // The token is gone from the page; only its mask is shown.
    expect(screen.queryByDisplayValue(/123:ok/)).toBeNull()
    expect(screen.getByText('••••••x9Zq')).toBeInTheDocument()
  })

  it('names the paired chat, and says a hand-typed one cannot answer back', async () => {
    tg.state = { bot_set: true, bot_username: 'my_bot', chat_set: true, chat_name: 'Dima', polling: true }
    const { unmount } = render(<TelegramBotFields onSaved={() => {}} />)
    expect(await screen.findByText('Dima')).toBeInTheDocument()
    expect(screen.getByText('Pair again')).toBeInTheDocument()
    unmount()
    tg.state = { bot_set: true, chat_set: true, manual_chat: true, polling: false }
    render(<TelegramBotFields onSaved={() => {}} />)
    expect(await screen.findByText(/typed in by hand/)).toBeInTheDocument()
  })
})
