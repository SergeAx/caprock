/**
 * The session deck (.ai/21-app.md § What the user sees, Session deck): a band
 * under the terminal of the agent in front. Opening it pushes the terminal's
 * bottom up, so Claude Code's prompt sits nearer the middle of the screen
 * than its edge (owner, 2026-10-11, translated: "I basically type in the
 * centre, a bit below the middle of the screen — that's comfortable — and in
 * this new area show data useful to me while I work"), and the room it makes
 * carries the session's live figures in one dense row: what it is doing now,
 * what it has cost and what the next call costs, how full its context is,
 * the plan windows, and its last hour as one bar per minute.
 *
 * Every figure is one the workspace already holds: the session row the sidebar
 * polls, the day's summary, and the session's own calls and turns — fetched
 * once and followed on the live socket, shared with the cockpit
 * (lib/sessionEvents.ts). Nothing is estimated, and a figure the agent does
 * not report is left out rather than drawn as zero.
 *
 * Cheap on purpose. It is a sibling of the terminals, so nothing here redraws
 * one. Closed, it is not mounted: no clock, no subscription. While its
 * divider is dragged the band grows over the terminal and the terminal's own
 * box changes once, on release — one fit and one PTY resize, not one per
 * frame. Arrow keys on the divider settle the same way.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { RateWindow, SessionSummary, Summary } from '@/lib/api'
import { useSessionEvents, EVENTS_HELD } from '@/lib/sessionEvents'
import { useNow } from '@/lib/useNow'
import { fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { cockpitState, fmtRun, planWindowsFor, runningTool, toolRuns, turnCosts, type CockpitState, type ToolRun } from '@/lib/cockpit'
import { buildPulse, windowCost, windowEvents } from '@/lib/pulse'
import { DECK_DEFAULT, DECK_MAX_SHARE, DECK_TALL, clampDeck, deckKeyStep, pulseMinutes } from '@/lib/deck'
import { readWindow } from './PlanLimits'
import { PulseCanvas } from './Pulse'
import { agentName } from './Characters'
import { CloseIcon } from './AppIcons'
import { keys } from '@/lib/appkeys'
import { countdown, resetClock } from '@/lib/limitclock'

/** How long arrow keys on the divider rest before the terminal is fitted to the new height. */
export const KEY_SETTLE_MS = 250

const STATE_LABEL: Record<CockpitState, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  looping: 'Looping?',
  idle: 'Idle',
  ended: 'Ended',
}

const STATE_TEXT: Record<CockpitState, string> = {
  working: 'text-ok',
  waiting: 'text-accent',
  looping: 'text-danger',
  idle: 'text-fg-muted',
  ended: 'text-fg-faint',
}

export interface SessionDeckProps {
  s: SessionSummary
  sessionId: string
  hasPermission: boolean
  /** The day's summary: the plan windows. */
  summary?: Summary
  /** Files changed in the session's checkout, as the sidebar counts them; absent when not known. */
  changed?: number
  onReviewChanges?: () => void
  /** The height kept, in CSS pixels. */
  height: number
  /** A new height, once a drag or the arrow keys settle. */
  onResize: (height: number) => void
  onClose: () => void
}

export function SessionDeck(props: SessionDeckProps) {
  const { height, onResize } = props
  const box = useRef<HTMLDivElement>(null)
  // The height while the divider moves: the band is drawn at it, over the
  // terminal, and the terminal's own box waits for the release.
  const [draft, setDraft] = useState<number | null>(null)
  const settle = useRef(0)
  useEffect(() => () => window.clearTimeout(settle.current), [])

  const pane = () => box.current?.parentElement?.clientHeight || undefined
  const current = () => draft ?? (box.current?.getBoundingClientRect().height || height)

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const y0 = e.clientY
    const h0 = current()
    const p = pane()
    let last: number | null = null
    const onMove = (m: PointerEvent) => {
      last = clampDeck(h0 + (y0 - m.clientY), p)
      setDraft(last)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.documentElement.removeAttribute('data-deck-drag')
      if (last !== null && last !== Math.round(h0)) onResize(last)
      setDraft(null)
    }
    document.documentElement.setAttribute('data-deck-drag', '')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const nudge = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && draft !== null) {
      e.preventDefault()
      window.clearTimeout(settle.current)
      setDraft(null)
      return
    }
    const next = deckKeyStep(e.key, current(), pane())
    if (next === undefined) return
    e.preventDefault()
    setDraft(next)
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      onResize(next)
      setDraft(null)
    }, KEY_SETTLE_MS)
  }

  const shown = draft ?? height
  return (
    <div
      ref={box}
      data-deck
      className="relative shrink-0"
      // Never past its share of the pane, whatever was kept: a window made
      // smaller since must not leave the terminal a sliver.
      style={{ height: `min(${height}px, ${DECK_MAX_SHARE * 100}%)` }}
    >
      <section
        aria-label="Session deck"
        className="absolute inset-x-0 bottom-0 z-30 flex flex-col border-t border-[var(--app-hairline-strong)] bg-[var(--app-chrome-bg)]"
        style={{ height: draft !== null ? `${draft}px` : '100%' }}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the session deck"
          aria-valuenow={Math.round(shown)}
          aria-valuemin={0}
          tabIndex={0}
          title="Drag to resize · double-click for the default height"
          onPointerDown={drag}
          onKeyDown={nudge}
          onDoubleClick={() => onResize(clampDeck(DECK_DEFAULT, pane()))}
          className="deck-divider group absolute inset-x-0 -top-[4px] z-10 h-[8px] cursor-row-resize outline-none"
          data-dragging={draft !== null || undefined}
        >
          <span aria-hidden className="deck-grip absolute left-1/2 top-[2px] h-[4px] w-[36px] -translate-x-1/2 rounded-full" />
        </div>
        <DeckBody {...props} tall={shown >= DECK_TALL} />
      </section>
    </div>
  )
}

function DeckBody({ s, sessionId, hasPermission, summary, changed, onReviewChanges, onClose, tall }: SessionDeckProps & { tall: boolean }) {
  const main = useSessionEvents(sessionId)
  const now = useNow(1000)
  const runs = useMemo(() => toolRuns(main), [main])
  const turns = useMemo(() => turnCosts(main), [main])
  const state = cockpitState(s, hasPermission)
  const running = state === 'working' || state === 'looping' ? runningTool(runs, now) : undefined
  const plan = planWindowsFor(s.agent, summary)
  // Rounded to the minute, as on the Now screen, so the bars are rebuilt once
  // a minute and when an event arrives, not every second.
  const minute = Math.floor(now / 60_000) * 60_000
  const minutes = pulseMinutes(main, minute, EVENTS_HELD)
  const pulse = useMemo(() => buildPulse([...main], minute, minutes), [main, minute, minutes])
  const st = s.stats
  const last = turns[turns.length - 1]
  const ctx = s.context
  return (
    // A container, so the cells that matter least give way first as the
    // terminal narrows (the sidebar and the inspector both open): the changed
    // files, then the plan windows, which the sidebar's Today strip and the
    // cockpit also carry. The bars and what it is doing never go.
    <div className="@container flex min-h-0 flex-1 items-stretch overflow-hidden">
      <Cell label="Now" className="min-w-[180px] flex-[1.3_1_0]">
        <Doing s={s} state={state} running={running} last={runs[runs.length - 1]} hasPermission={hasPermission} now={now} />
        {tall && runs.length > 0 && <RecentTools runs={runs} now={now} />}
      </Cell>
      {st && (
        <Cell label="Spent" className="w-[132px] shrink-0">
          <p className="num text-[20px] font-semibold leading-none tracking-[-0.02em] text-fg" aria-label={`Cost ${fmtUSD(st.cost_usd)}`}>{fmtUSD(st.cost_usd)}</p>
          {last && <p className="num truncate text-[11px] text-fg-muted" title="What the newest model call cost">last call <span className="text-fg">{fmtUSD(last.cost)}</span></p>}
          {tall && <p className="num truncate text-[11px] text-fg-faint">{st.turns} turns</p>}
          {tall && <p className="num truncate text-[11px] text-fg-faint">{st.tool_calls} tool calls</p>}
        </Cell>
      )}
      {ctx && <Context ctx={ctx} tall={tall} />}
      {plan && (
        <Cell label="Plan" className="w-[176px] shrink-0" below={720} right={<span title={`Every ${agentName(s.agent ?? 'claude')} session shares these windows`}>all sessions</span>}>
          {plan.five_hour && <Window label="5-hour" w={plan.five_hour} now={now} tall={tall} />}
          {plan.seven_day && <Window label="Weekly" w={plan.seven_day} now={now} tall={tall} />}
        </Cell>
      )}
      {tall && typeof changed === 'number' && (
        <Cell label="Changes" className="w-[100px] shrink-0" below={1000}>
          <p className="num text-[15px] font-medium leading-tight text-fg">{changed} {changed === 1 ? 'file' : 'files'}</p>
          {onReviewChanges && changed > 0 && (
            <button type="button" onClick={onReviewChanges} className="w-fit text-left text-[11px] text-accent underline-offset-2 hover:underline">Review</button>
          )}
        </Cell>
      )}
      <Cell
        label={`Last ${minutes} min`}
        className="min-w-[188px] flex-[2.2_1_0]"
        right={windowEvents(pulse) > 0 ? <span className="num" title={`What this session spent in the last ${minutes} minutes`}>{fmtUSD(windowCost(pulse))}</span> : <span>one bar per minute</span>}
        grow
      >
        {/* As tall as the figures beside it, not the whole deck: the bars
            are one cell among several (owner, 2026-10-11: the big chart
            distracts). */}
        <PulseCanvas pulse={pulse} now={minute} sessionID={sessionId} />
      </Cell>
      <div className="flex shrink-0 items-start pr-1.5 pt-1.5">
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close the session deck (${keys('⌘B')})`}
          title={`Close (${keys('⌘B')})`}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>
  )
}

/** The display classes of a cell that is drawn only from a container width up; literal, so Tailwind finds them. */
const SHOWN_FROM: Record<number, string> = {
  720: 'hidden @min-[720px]:flex',
  1000: 'hidden @min-[1000px]:flex',
}

function Cell({ label, right, className = '', grow = false, below, children }: { label: string; right?: ReactNode; className?: string; grow?: boolean; below?: 720 | 1000; children: ReactNode }) {
  return (
    <div className={`${below ? SHOWN_FROM[below] : 'flex'} min-w-0 flex-col gap-1 border-r border-[var(--app-hairline)] px-3 pb-2 pt-2 last-of-type:border-r-0 ${grow ? '' : 'overflow-hidden'} ${className}`}>
      <div className="flex items-baseline gap-2">
        <h4 className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{label}</h4>
        {right && <div className="ml-auto min-w-0 truncate text-[11px] text-fg-faint">{right}</div>}
      </div>
      {children}
    </div>
  )
}

/** The state, and what the agent is doing this second — the cockpit's Now line, in one row. */
function Doing({ s, state, running, last, hasPermission, now }: { s: SessionSummary; state: CockpitState; running?: ToolRun; last?: ToolRun; hasPermission: boolean; now: number }) {
  const subs = s.live_subagents ?? 0
  let verb = ''
  let detail = ''
  let since = ''
  if (hasPermission && state !== 'ended') {
    verb = 'Asks your permission'
    detail = 'answer in the terminal'
  } else if (running) {
    verb = running.tool.startsWith('mcp__') ? running.tool.replace(/^mcp__(.+?)__/, '$1·') : running.tool
    detail = running.detail
    since = fmtRun(Math.max(0, now - running.startMs))
  } else if (state === 'working' && last?.endMs !== undefined) {
    verb = 'Thinking'
    detail = `after ${last.tool}`
    since = fmtRun(Math.max(0, now - last.endMs))
  } else if (s.activity?.phrase && state !== 'ended') {
    verb = s.activity.phrase[0]!.toUpperCase() + s.activity.phrase.slice(1)
  }
  const model = s.model_display || s.model
  return (
    <>
      <p className={`flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium ${STATE_TEXT[state]}`} role="status">
        <span className="cockpit-dot inline-block h-[7px] w-[7px] shrink-0 rounded-full" data-state={state} />
        <span className="shrink-0">{STATE_LABEL[state]}</span>
        {subs > 0 && state !== 'ended' && <span className="shrink-0 font-normal text-fg-muted">· {subs} {subs === 1 ? 'subagent' : 'subagents'}</span>}
        {model && <span className="min-w-0 truncate font-normal text-fg-faint">· {model}</span>}
      </p>
      {verb && (
        <p className="flex min-w-0 items-baseline gap-1.5 text-[12px]" title={detail ? `${verb} ${detail}` : verb}>
          <span className="shrink-0 text-fg">{verb}</span>
          {detail && <span className="mono min-w-0 truncate text-[11.5px] text-fg-muted">{detail}</span>}
          {since && <span className="num ml-auto shrink-0 text-[11px] text-ok">{since}</span>}
        </p>
      )}
    </>
  )
}

/** The last few calls, newest first, one line each: what a taller deck has room for. */
function RecentTools({ runs, now }: { runs: ToolRun[]; now: number }) {
  const rows = runs.slice(-3, running(runs) ? -1 : undefined).reverse()
  if (rows.length === 0) return null
  return (
    <ol aria-label="Recent tool calls" className="mt-0.5 grid gap-px">
      {rows.map((r) => (
        <li key={r.id} className="flex min-w-0 items-baseline gap-1.5 text-[11px]" title={`${r.tool}${r.detail ? ` — ${r.detail}` : ''}`}>
          <span className={`shrink-0 ${r.failed ? 'text-danger' : 'text-fg-muted'}`}>{r.tool.startsWith('mcp__') ? r.tool.replace(/^mcp__(.+?)__/, '$1·') : r.tool}</span>
          {r.detail && <span className="mono min-w-0 truncate text-fg-faint">{r.detail}</span>}
          <span className="num ml-auto shrink-0 text-fg-faint">{r.failed ? 'failed' : fmtRun(Math.max(0, (r.endMs ?? now) - r.startMs))}</span>
        </li>
      ))}
    </ol>
  )
}

function running(runs: ToolRun[]): boolean {
  return runs.length > 0 && runs[runs.length - 1]!.endMs === undefined
}

function Context({ ctx, tall }: { ctx: NonNullable<SessionSummary['context']>; tall: boolean }) {
  const pct = Math.max(0, Math.min(100, ctx.pct))
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  return (
    <Cell label="Context" className="w-[136px] shrink-0">
      <p className={`num text-[20px] font-semibold leading-none tracking-[-0.02em] ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{fmtPct(pct)}</p>
      <div className="cockpit-track relative h-[5px] overflow-hidden rounded-full" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="cockpit-fill h-full rounded-full" data-tone={tone} style={{ width: `${Math.max(pct, 1.5)}%` }} />
      </div>
      {ctx.next_call_usd > 0 && (
        <p className="num truncate text-[11px] text-fg-muted" title="What every call now pays to re-read the context">next call <span className="text-fg">{fmtUSD(ctx.next_call_usd)}</span></p>
      )}
      {tall && <p className="num truncate text-[11px] text-fg-faint">{fmtTokens(ctx.tokens)} / {fmtTokens(ctx.window)}</p>}
    </Cell>
  )
}

function Window({ label, w, now, tall }: { label: string; w: RateWindow; now: number; tall: boolean }) {
  const { pct, stale, resetsAt } = readWindow(w, now)
  const resetMs = w.resets_at * 1000
  const tone = pct > 85 ? 'danger' : pct >= 60 ? 'warn' : 'accent'
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)_32px] items-center gap-x-2" title={stale ? undefined : resetsAt ? `resets ${resetClock(resetMs, now)} · in ${countdown(resetMs - now)}` : undefined}>
      <span className="text-[11px] text-fg-muted">{label}</span>
      <div className="cockpit-track h-[5px] overflow-hidden rounded-full" role="meter" aria-label={`${label} window used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="cockpit-fill h-full rounded-full" data-tone={tone} style={{ width: `${Math.max(1.5, Math.min(100, pct))}%` }} />
      </div>
      <span className={`num text-right text-[11.5px] font-medium ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{pct}%</span>
      {tall && <><span />
      <span className="col-span-2 truncate text-[10.5px] text-fg-faint">{stale ? 'reset time stale' : resetsAt ? `resets ${resetClock(resetMs, now)}` : ''}</span></>}
    </div>
  )
}
