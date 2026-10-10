import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Subscription, SubscriptionsResponse } from '@/lib/api'

function sub(over: Partial<Subscription>): Subscription {
  return {
    id: 'default', agent: 'claude', label: 'Default', default: true, dir: '/h/.claude', signed_in: true, login_command: 'claude auth login',
    windows: [], sessions_7d: 0, cost_7d_usd: 0, running: 0, ...over,
  }
}

const m = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn(), rename: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      subscriptions: m.list, addSubscription: m.add, removeSubscription: m.remove, renameSubscription: m.rename,
      premium: async () => ({
        yearly: { per_month_usd: 2.5, charged_usd: 30, period: 'year', url: 'https://buy/y' },
        lifetime: { per_month_usd: 0, charged_usd: 100, period: 'once', url: 'https://buy/l' },
        info_url: 'https://caprock.dev/premium/',
        license: { active: false, in_grace: false },
      }),
    },
  }
})

import { SubscriptionsSetting } from './SubscriptionsSetting'
import { SetupShellContext } from '@/lib/setupShell'
import { SubscriptionNote } from './SubscriptionPicker'

function response(claude: Subscription[], licensed = false): SubscriptionsResponse {
  return {
    agents: [
      { agent: 'claude', label: 'Claude Code', installed: true, subscriptions: claude },
      { agent: 'codex', label: 'Codex', installed: false, subscriptions: [sub({ agent: 'codex', dir: '/h/.codex', signed_in: false })] },
    ],
    licensed, free_per_agent: 3, home: '/h',
  }
}

describe('Settings → Subscriptions', () => {
  it('adds one and types its sign-in into a shell tab', async () => {
    m.list.mockResolvedValue(response([sub({ account: 'me@example.com' })]))
    const added = sub({ id: 'ab12cd34', label: 'Work', default: false, dir: '/d/profiles/ab12cd34', signed_in: false, env_var: 'CLAUDE_CONFIG_DIR', login_command: "CLAUDE_CONFIG_DIR='/d/profiles/ab12cd34' claude auth login" })
    m.add.mockResolvedValueOnce(added)
    const setup = vi.fn()
    render(<SetupShellContext.Provider value={setup}><SubscriptionsSetting /></SetupShellContext.Provider>)
    expect(await screen.findByText('me@example.com')).toBeInTheDocument()
    // Codex is not installed and has only its Default: not listed.
    expect(screen.queryByRole('list', { name: 'Codex subscriptions' })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Work Max'), { target: { value: 'Work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith('claude', 'Work'))
    await waitFor(() => expect(setup).toHaveBeenCalledWith(added.login_command, '/h'))
  })

  it('shows the Premium path at the free number, without asking the daemon', async () => {
    m.list.mockResolvedValue(response([sub({}), sub({ id: 'a1', label: 'Work', default: false }), sub({ id: 'b2', label: 'Home', default: false })]))
    m.add.mockClear()
    render(<SubscriptionsSetting />)
    expect(await screen.findByText(/the free number/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    expect(m.add).not.toHaveBeenCalled()
    expect(await screen.findByText('More sign-ins, each a pick away')).toBeInTheDocument()
  })

  it('asks before removing, and shows the command to copy in a browser', async () => {
    m.list.mockResolvedValue(response([sub({}), sub({ id: 'a1', label: 'Work', default: false, signed_in: false, login_command: 'X=1 claude auth login' })]))
    m.remove.mockResolvedValueOnce(undefined)
    render(<SubscriptionsSetting />)
    await screen.findByText('Work')
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0]!)
    expect(await screen.findByText('X=1 claude auth login')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByText(/Its folder is deleted/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Work' }))
    await waitFor(() => expect(m.remove).toHaveBeenCalledWith('a1'))
  })
})

describe('the near-limit note', () => {
  const soon = Date.now() / 1000 + 3600
  const list = [
    sub({ windows: [{ window: 'five_hour', used_percentage: 93, resets_at: soon, observed_at: 0 }] }),
    sub({ id: 'a1', label: 'Personal', default: false, windows: [{ window: 'five_hour', used_percentage: 12, resets_at: soon, observed_at: 0 }] }),
  ]
  it('says how full the chosen one is and offers one with room for this session', () => {
    const use = vi.fn()
    render(<SubscriptionNote list={list} value="default" onUse={use} />)
    expect(screen.getByRole('note')).toHaveTextContent('Default: 93% of its 5-hour window used')
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }))
    expect(use).toHaveBeenCalledWith('a1')
  })
  it('says nothing when the chosen one has room', () => {
    const { container } = render(<SubscriptionNote list={list} value="a1" onUse={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
