import { describe, expect, it, beforeEach } from 'vitest'
import type { Subscription } from './api'
import { forgetSubscription, fullest, isNear, rememberedSubscription, rememberSubscription, withRoom } from './subscriptions'

const NOW = 1_800_000_000

function sub(id: string, windows: [Subscription['windows'][number]['window'], number, number?][], signedIn = true): Subscription {
  return {
    id, agent: 'claude', label: id, default: id === 'default', dir: `/d/${id}`, signed_in: signedIn, login_command: 'claude auth login',
    windows: windows.map(([window, used, resets = NOW + 3600]) => ({ window, used_percentage: used, resets_at: resets, observed_at: 0 })),
    sessions_7d: 0, cost_7d_usd: 0, running: 0,
  }
}

describe('subscriptions', () => {
  beforeEach(() => localStorage.clear())

  it('reads the fullest current window and ignores one that has reset', () => {
    const s = sub('a', [['five_hour', 95, NOW - 10], ['seven_day', 40]])
    expect(fullest(s, NOW)?.window).toBe('seven_day')
    expect(isNear(s, NOW)).toBe(false)
    expect(isNear(sub('b', [['five_hour', 90]]), NOW)).toBe(true)
    expect(isNear(sub('c', []), NOW)).toBe(false)
  })

  it('offers the ones with room, known figures first, never the chosen or a signed-out one', () => {
    const list = [sub('default', [['five_hour', 93]]), sub('work', [['five_hour', 60]]), sub('home', []), sub('team', [['five_hour', 20]]), sub('new', [], false), sub('full', [['seven_day', 99]])]
    expect(withRoom(list, 'default', NOW).map((s) => s.id)).toEqual(['team', 'work', 'home'])
  })

  it('remembers a pick per agent and project, and forgets a removed one', () => {
    expect(rememberedSubscription('claude', 'p1')).toBe('default')
    rememberSubscription('claude', 'p1', 'ab12')
    rememberSubscription('codex', 'p1', 'cd34')
    expect(rememberedSubscription('claude', 'p1')).toBe('ab12')
    expect(rememberedSubscription('claude', 'p2')).toBe('default')
    forgetSubscription('ab12')
    expect(rememberedSubscription('claude', 'p1')).toBe('default')
    expect(rememberedSubscription('codex', 'p1')).toBe('cd34')
  })
})
