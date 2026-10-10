/**
 * Which sign-in a new Claude Code or Codex session runs on (ADR-048), beside
 * the Agent picker in New agent and Quick chat.
 *
 * Shown only when the agent has more than one subscription: one sign-in is no
 * choice. The pick is remembered per project (lib/subscriptions.ts). When the
 * chosen one is at or past 90% of a plan window, the note under it says so
 * and names one with room, which a click picks for this session only — the
 * remembered choice stays, a running session never moves, and nothing is
 * ever picked without the click.
 */
import { useMemo } from 'react'
import { api, type Subscription } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fullest, hasSubscriptions, isNear, resetText, roomText, windowLabel, withRoom } from '@/lib/subscriptions'

/** The daemon's list, fetched once; empty on a daemon that predates it. */
export function useSubscriptionList(): { all: Subscription[]; loaded: boolean; refresh: () => void } {
  const res = useApi(() => api.subscriptions(), [], { live: false })
  const all = useMemo(() => res.data?.agents.flatMap((a) => a.subscriptions) ?? [], [res.data])
  return { all, loaded: !!res.data || !!res.error, refresh: () => res.refresh?.() }
}

/** One agent's subscriptions, the Default one first. */
export function subscriptionsFor(all: readonly Subscription[], agent: string): Subscription[] {
  return hasSubscriptions(agent) ? all.filter((s) => s.agent === agent) : []
}

/** What an option says: its name, and what is in the way. */
export function optionText(s: Subscription, nowSec = Date.now() / 1000): string {
  const parts = [s.label]
  if (!s.signed_in) parts.push('not signed in')
  else {
    const f = fullest(s, nowSec)
    if (f) parts.push(`${Math.round(f.used_percentage)}% ${windowLabel(f.window)}`)
  }
  return parts.join(' · ')
}

export function SubscriptionPicker({
  list,
  value,
  onChange,
  className = 'input',
}: {
  /** This agent's subscriptions (subscriptionsFor). */
  list: readonly Subscription[]
  value: string
  /** The viewer picked one: remember it. */
  onChange: (id: string) => void
  className?: string
}) {
  if (list.length < 2) return null
  return (
    <label className="grid min-w-0 gap-1">
      <span className="text-[11px] text-fg-muted">Subscription</span>
      <select
        className={className}
        value={list.some((s) => s.id === value) ? value : 'default'}
        onChange={(e) => onChange(e.target.value)}
        // Quick chat's arrows move its own lists; a select keeps its own.
        onKeyDown={(e) => { if (e.key.startsWith('Arrow')) e.stopPropagation() }}
      >
        {list.map((s) => (
          <option key={s.id} value={s.id}>{optionText(s)}</option>
        ))}
      </select>
    </label>
  )
}

/**
 * Under the picker: the chosen subscription is near a window's line, or not
 * signed in. `onUse` picks another for this session only.
 */
export function SubscriptionNote({
  list,
  value,
  onUse,
}: {
  list: readonly Subscription[]
  value: string
  onUse: (id: string) => void
}) {
  if (list.length < 2) return null
  const chosen = list.find((s) => s.id === value) ?? list[0]
  if (!chosen) return null
  if (!chosen.signed_in) {
    return (
      <p role="note" className="text-[12px] leading-snug text-fg-muted">
        {chosen.label} is not signed in yet: sign in from Settings → Subscriptions, or the session will ask.
      </p>
    )
  }
  if (!isNear(chosen)) return null
  const f = fullest(chosen)!
  const other = withRoom(list, chosen.id)[0]
  return (
    <div role="note" className="grid gap-1.5 rounded-[8px] border border-border px-3 py-2 text-[12px] leading-snug">
      <p className="text-fg">
        {chosen.label}: {Math.round(f.used_percentage)}% of its {windowLabel(f.window)} window used
        {f.resets_at ? <>, resets {resetText(f.resets_at)}</> : null}.
      </p>
      {other && (
        <p className="text-fg-muted">
          You choose which subscription this session uses:{' '}
          <button type="button" onClick={() => onUse(other.id)} className="text-accent underline-offset-2 hover:underline">
            {other.label}
          </button>{' '}
          <span className="text-fg-faint">({roomText(other)})</span>. Running sessions stay where they are.
        </p>
      )}
    </div>
  )
}

/**
 * The subscription a session ran on, by name, for the session's card, the
 * inspector and its page. Nothing for the Default sign-in — most sessions —
 * and the list is only asked for when a session has one.
 */
export function SubscriptionTag({ id, prefix = ' · ' }: { id?: string; prefix?: string }) {
  if (!id) return null
  return <SubscriptionTagFor id={id} prefix={prefix} />
}

function SubscriptionTagFor({ id, prefix }: { id: string; prefix: string }) {
  const { all, loaded } = useSubscriptionList()
  if (!loaded) return null
  const s = all.find((x) => x.id === id)
  return (
    <span title={s ? `Ran on the ${s.label} subscription` : 'Ran on a subscription that has since been removed'}>
      {prefix}{s ? s.label : 'removed subscription'}
    </span>
  )
}
