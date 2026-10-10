/**
 * Subscriptions (ADR-048): which sign-in a new Claude Code or Codex session
 * runs on, and what the pickers say about each one's plan windows.
 *
 * The note near a limit is information and a one-click choice for the next
 * session, never a switch: a running session stays on its sign-in, and
 * nothing here ever picks another subscription on its own.
 */
import type { Subscription, SubscriptionWindow } from './api'

/** At or above this share of a window, the picker says so. */
export const NEAR_PCT = 90

export function hasSubscriptions(agent: string): agent is 'claude' | 'codex' {
  return agent === 'claude' || agent === 'codex'
}

/** "5-hour" or "weekly". */
export function windowLabel(w: SubscriptionWindow['window']): string {
  return w === 'five_hour' ? '5-hour' : 'weekly'
}

/** The windows still current: one whose reset has passed says nothing about now. */
export function currentWindows(sub: Subscription, nowSec = Date.now() / 1000): SubscriptionWindow[] {
  return sub.windows.filter((w) => !w.resets_at || w.resets_at > nowSec)
}

/** The fullest current window, or undefined when none is known. */
export function fullest(sub: Subscription, nowSec = Date.now() / 1000): SubscriptionWindow | undefined {
  return currentWindows(sub, nowSec).reduce<SubscriptionWindow | undefined>((a, w) => (!a || w.used_percentage > a.used_percentage ? w : a), undefined)
}

export function isNear(sub: Subscription, nowSec = Date.now() / 1000): boolean {
  const f = fullest(sub, nowSec)
  return !!f && f.used_percentage >= NEAR_PCT
}

/**
 * The subscriptions of the same agent that have room, best first: signed in,
 * no current window at the line. Known figures before unknown ones, lowest
 * first; the chosen one is never among them.
 */
export function withRoom(list: readonly Subscription[], chosenId: string, nowSec = Date.now() / 1000): Subscription[] {
  const rest = list.filter((s) => s.id !== chosenId && s.signed_in && !isNear(s, nowSec))
  const pct = (s: Subscription) => fullest(s, nowSec)?.used_percentage ?? Infinity
  return [...rest].sort((a, b) => pct(a) - pct(b))
}

/** "12% of the 5-hour window" or "no figures yet". */
export function roomText(sub: Subscription, nowSec = Date.now() / 1000): string {
  const f = fullest(sub, nowSec)
  return f ? `${Math.round(f.used_percentage)}% of the ${windowLabel(f.window)} window` : 'no figures yet'
}

/** HH:MM, or a weekday and HH:MM when the reset is not today. */
export function resetText(resetsAt: number, now = new Date()): string {
  const d = new Date(resetsAt * 1000)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`
}

// Remembered per viewer, per agent and per project: someone who works on a
// client's repository on the client's account picks it once there.
const PREFIX = 'caprock.subscription.'

function key(agent: string, project: string): string {
  return `${PREFIX}${agent}.${project || '-'}`
}

export function rememberedSubscription(agent: string, project: string): string {
  try {
    return localStorage.getItem(key(agent, project)) ?? 'default'
  } catch {
    return 'default'
  }
}

export function rememberSubscription(agent: string, project: string, id: string): void {
  try {
    if (id === 'default') localStorage.removeItem(key(agent, project))
    else localStorage.setItem(key(agent, project), id)
  } catch {
    // Not remembering is fine.
  }
}

/** Forget a removed subscription wherever this browser remembered it. */
export function forgetSubscription(id: string): void {
  try {
    const drop: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX) && localStorage.getItem(k) === id) drop.push(k)
    }
    drop.forEach((k) => localStorage.removeItem(k))
  } catch {
    // Nothing remembered, nothing to forget.
  }
}
