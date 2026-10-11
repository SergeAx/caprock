/**
 * The session deck (.ai/21-app.md § What the user sees, Session deck): a band
 * under the terminal of the agent in front. Opening it pushes the terminal's
 * bottom up, so Claude Code's prompt sits nearer the middle of the screen
 * than its edge (owner, 2026-10-11, translated: "I basically type in the
 * centre, a bit below the middle of the screen — that's comfortable — and in
 * this new area show data useful to me while I work"), and the room it makes
 * carries the session's live figures in one dense row: what it is doing now,
 * what it has cost and what the next call costs, how full its context is,
 * the branch with what is not committed or pushed, and the session's latest
 * pull requests with their CI. No chart: the dashboard has those (owner,
 * 2026-10-11: "we already have charts everywhere").
 *
 * Every figure but the pull requests' is one the workspace already holds: the
 * session row the sidebar polls and the session's own calls and turns — fetched
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
import { api, type SessionPRLive, type SessionSummary, type Summary } from '@/lib/api'
import { useSessionEvents } from '@/lib/sessionEvents'
import { useNow } from '@/lib/useNow'
import { fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { cockpitState, fmtRun, runningTool, toolRuns, turnCosts, type CockpitState, type ToolRun } from '@/lib/cockpit'
import { DECK_DEFAULT, DECK_MAX_SHARE, DECK_TALL, clampDeck, deckKeyStep } from '@/lib/deck'
import { githubApi, prTone, type PRTone } from '@/lib/github'
import { openExternal } from '@/lib/nudges'
import { CloseIcon } from './AppIcons'
import { keys } from '@/lib/appkeys'

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
  /** The checkout's branch and commits not pushed, as the sidebar knows them. */
  branch?: string
  ahead?: number
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

function DeckBody({ s, sessionId, hasPermission, changed, branch, ahead, onReviewChanges, onClose, tall }: SessionDeckProps & { tall: boolean }) {
  const main = useSessionEvents(sessionId)
  const now = useNow(1000)
  const runs = useMemo(() => toolRuns(main), [main])
  const turns = useMemo(() => turnCosts(main), [main])
  const state = cockpitState(s, hasPermission)
  const running = state === 'working' || state === 'looping' ? runningTool(runs, now) : undefined
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
      <Branch branch={branch || s.git_branch} changed={changed} ahead={ahead} onReview={onReviewChanges} />
      <PRs sessionId={sessionId} />
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


/** How often the PR cell asks again: sooner while a check is running. The
 *  daemon keeps each pull request for about as long, so a poll it can answer
 *  from what it holds costs GitHub nothing. */
const PRS_PENDING_MS = 20_000
const PRS_IDLE_MS = 60_000

const PR_DOT: Record<PRTone, string> = {
  ok: 'bg-ok', fail: 'bg-danger', pending: 'bg-warn', merged: 'bg-[#a371f7]', closed: 'bg-fg-faint', none: 'bg-fg-faint/70',
}

/** The branch the session works on, what is not committed and what is not pushed. */
function Branch({ branch, changed, ahead, onReview }: { branch?: string; changed?: number; ahead?: number; onReview?: () => void }) {
  if (!branch) return null
  const bits = [
    typeof changed === 'number' ? (changed ? `${changed} not committed` : 'clean') : '',
    ahead ? `${ahead} not pushed` : '',
  ].filter(Boolean)
  return (
    <Cell label="Branch" className="w-[176px] shrink-0" below={720}>
      <p className="mono truncate text-[13px] font-medium text-fg" title={branch}>{branch}</p>
      {bits.length > 0 && <p className={`truncate text-[11.5px] ${changed || ahead ? 'text-warn' : 'text-fg-muted'}`}>{bits.join(' · ')}</p>}
      {onReview && !!changed && (
        <button type="button" onClick={onReview} className="w-fit text-left text-[11.5px] text-accent underline-offset-2 hover:underline">Review changes</button>
      )}
    </Cell>
  )
}

/** One PR's state in a few characters: CI first, then the review. */
function prStatus(p: SessionPRLive): { text: string; tone: PRTone } {
  const pr = p.live
  if (!pr) {
    if (p.merged_at) return { text: 'merged', tone: 'merged' }
    if (p.closed_at) return { text: 'closed', tone: 'closed' }
    return { text: 'open', tone: 'none' }
  }
  const tone = prTone(pr)
  if (pr.state !== 'open') return { text: pr.state, tone }
  const c = pr.checks
  const total = c.items.length
  let ci = ''
  if (c.state === 'fail') {
    const failed = c.items.filter((i) => i.state === 'fail').map((i) => i.name)
    ci = `CI failed: ${failed.slice(0, 1).join('')}${failed.length > 1 ? ` +${failed.length - 1}` : ''}`
  } else if (c.state === 'pending') ci = `CI ${total - c.pending}/${total}`
  else if (c.state === 'pass') ci = 'CI passed'
  const review = pr.review === 'approved' ? 'approved' : pr.review === 'changes_requested' ? 'changes requested' : ''
  return { text: [pr.draft ? 'draft' : '', ci || 'no CI', review].filter(Boolean).join(' · '), tone }
}

const STATUS_TEXT: Record<PRTone, string> = {
  ok: 'text-ok', fail: 'text-danger', pending: 'text-warn', merged: 'text-[#a371f7]', closed: 'text-fg-faint', none: 'text-fg-muted',
}

/**
 * The session's latest pull requests and their CI (owner, 2026-10-11: "I'd
 * look at the statuses of the latest PRs, CI on them if possible"). Asked of
 * the daemon while the deck is open and the window is visible: every 20 s
 * while a check runs, else every minute.
 */
function PRs({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<{ connected: boolean; prs: SessionPRLive[] }>()
  const [connecting, setConnecting] = useState(false)
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    let timer = 0
    const tick = async () => {
      let next = PRS_IDLE_MS
      if (!document.hidden) {
        try {
          const d = await api.sessionPRs(sessionId)
          if (!alive) return
          setData(d)
          if (d.prs.some((p) => p.live?.checks.state === 'pending')) next = PRS_PENDING_MS
        } catch { /* the last answer stays */ }
      }
      if (alive) timer = window.setTimeout(() => void tick(), next)
    }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [sessionId, n])

  // One click turns the integration on through the GitHub CLI's own login
  // (ADR-047: off until the user turns it on; this button is that). Without
  // a usable `gh`, Settings is where a token goes.
  const connect = async () => {
    setConnecting(true)
    try {
      const st = await githubApi.connect('gh')
      if (st.connected) setN((x) => x + 1)
      else location.hash = '#/settings'
    } catch {
      location.hash = '#/settings'
    } finally {
      setConnecting(false)
    }
  }
  const prs = data?.prs ?? []
  return (
    <Cell label="Pull requests" className="min-w-[220px] flex-[2.2_1_0]"
      right={data && !data.connected && prs.length > 0
        ? <button type="button" disabled={connecting} onClick={() => void connect()} title="Reads CI and reviews through your GitHub CLI login; turn it off in Settings → GitHub" className="text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : 'connect GitHub for CI'}</button>
        : undefined}>
      {data && prs.length === 0 && <p className="text-[12px] text-fg-faint">No PR from this session yet.</p>}
      <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
        {prs.map((p) => {
          const st = prStatus(p)
          return (
            <li key={p.url} data-deck-pr={p.number} className="min-w-0">
              <button type="button" onClick={() => openExternal(p.live?.url || p.url)} title={`${p.live?.title || p.title || ''}\nOpen on GitHub`}
                className="flex w-full min-w-0 items-center gap-2 rounded-[5px] text-left text-[12.5px] hover:bg-[var(--app-row-hover)]">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${PR_DOT[st.tone]}`} />
                <span className="num shrink-0 text-fg">#{p.number}</span>
                <span className="min-w-0 flex-1 truncate text-fg-muted">{p.live?.title || p.title}</span>
                <span className={`shrink-0 whitespace-nowrap font-medium ${STATUS_TEXT[st.tone]}`}>{st.text}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </Cell>
  )
}
