/**
 * Compare attempts (ADR-052): the attempts one New agent started on the same
 * first message, side by side — what each is doing, what its copy changed
 * since the commit they all started from (files, lines added and taken
 * out), what it has cost so far and how long it has run. Each opens its tab
 * or its Changes view. Nothing is merged or removed here: the user reads,
 * picks one, and commits or opens a pull request from its Changes view.
 *
 * Over the terminals, as the Changes view is; read again every five seconds
 * while open, the way a cockpit is.
 */
import { useEffect, useState } from 'react'
import { api, errText, type AttemptsResponse, type AttemptView } from '@/lib/api'
import type { Dot } from '@/lib/sidebar'
import { fmtDuration, fmtUSD } from '@/lib/format'
import { agentName } from './Projects'
import { CloseIcon } from './AppIcons'

const REFRESH_MS = 5000

/** What an attempt is doing, in one word, and its tone: the sidebar's own
 *  reading of the session (`dot`) while it runs, else what the store says. */
export function attemptState(v: AttemptView, dot?: Dot): { word: string; tone: string } {
  const s = v.session
  if (s.status === 'ended' || dot === 'ended') return s.exit_code ? { word: `exited ${s.exit_code}`, tone: 'text-danger' } : { word: 'done', tone: 'text-fg-muted' }
  switch (dot) {
    case 'waiting': return { word: 'waiting on you', tone: 'text-warn' }
    case 'working': return { word: 'working', tone: 'text-ok' }
    case 'looping': return { word: 'looping', tone: 'text-danger' }
    case 'idle': return { word: 'idle', tone: 'text-fg-muted' }
    default: return { word: 'running', tone: 'text-fg-muted' }
  }
}

/** How long it has run: to now while it runs, to its last work once it ended. */
export function attemptDuration(v: AttemptView, now: number): number {
  const s = v.session
  const start = s.started_at || v.created_at
  if (!start) return 0
  const end = s.status === 'ended' ? (s.worked_at || s.last_event_at || start) : now
  return Math.max(0, end - start)
}

export function AttemptsCompare({
  group,
  title = '',
  dotFor,
  onClose,
  onOpen,
  onReview,
  className = '',
}: {
  group: string
  /** What they were asked, as the session list names it. */
  title?: string
  /** The sidebar's state of a session it lists (working, waiting on you…); undefined for one it does not. */
  dotFor?: (sessionId: string) => Dot | undefined
  onClose: () => void
  /** Opens the attempt's session in a tab. */
  onOpen: (v: AttemptView) => void
  /** Opens the Changes view of the attempt's copy; absent when that cannot be done here. */
  onReview?: (v: AttemptView) => void
  className?: string
}) {
  const [data, setData] = useState<AttemptsResponse | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let alive = true
    const load = () => api.attempts(group)
      .then((r) => { if (alive) { setData(r); setError(''); setNow(Date.now()) } })
      .catch((e: unknown) => { if (alive) setError(errText(e)) })
    void load()
    const id = window.setInterval(() => { void load() }, REFRESH_MS)
    return () => { alive = false; window.clearInterval(id) }
  }, [group])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const list = data?.attempts ?? []
  const cheapest = list.length > 1 ? Math.min(...list.map((v) => v.stats.cost_usd)) : NaN
  return (
    <section aria-label="Compare attempts" className={`flex min-h-0 flex-col bg-bg text-fg ${className}`}>
      <header className="flex h-[40px] shrink-0 items-center gap-3 border-b border-[var(--app-hairline)] px-4">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">
          Compare attempts{title && <span className="text-fg-muted"> · {title}</span>}
          {data?.base && <span className="text-fg-faint"> · from <span className="mono">{data.base}</span></span>}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close the comparison (Esc)" title="Close (Esc)" className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
          <CloseIcon size={13} />
        </button>
      </header>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-4">
        {error && !data && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        {!data && !error && <p className="text-[13px] text-fg-muted">Reading the attempts…</p>}
        {data && (
          <>
            <ol className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3" aria-label="Attempts">
              {list.map((v) => {
                const st = attemptState(v, dotFor?.(v.session_id))
                const c = v.changes
                return (
                  <li key={v.session_id} className="grid min-w-0 content-start gap-3 rounded-[10px] border border-[var(--app-hairline-strong)] bg-panel p-3.5">
                    <div className="flex items-baseline gap-2">
                      <h3 className="text-[14px] font-semibold">Attempt {v.n}</h3>
                      <span className="text-[12px] text-fg-faint">of {v.total}</span>
                      <span className={`ml-auto text-[12px] ${st.tone}`}>{st.word}</span>
                    </div>
                    <p className="-mt-2 min-w-0 truncate text-[12px] text-fg-muted" title={v.session.cwd}>
                      {agentName(v.session.agent)}{v.session.model ? ` · ${v.session.model}` : ''} · <span className="mono">{v.session.git_branch || v.session.worktree || '—'}</span>
                    </p>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
                      <div className="grid gap-0.5">
                        <dt className="text-fg-faint">Files changed</dt>
                        <dd className="num text-[15px] text-fg">{c ? c.files : '—'}</dd>
                      </div>
                      <div className="grid gap-0.5">
                        <dt className="text-fg-faint">Lines</dt>
                        <dd className="num text-[15px]">
                          {c ? <><span className="text-ok">+{c.additions}</span> <span className="text-danger">−{c.deletions}</span></> : '—'}
                        </dd>
                      </div>
                      <div className="grid gap-0.5">
                        <dt className="text-fg-faint">Cost so far</dt>
                        <dd className="num text-[15px] text-fg">
                          {fmtUSD(v.stats.cost_usd)}
                          {v.stats.cost_usd === cheapest && list.some((x) => x.stats.cost_usd !== cheapest) && <span className="ml-1.5 text-[11px] text-ok">cheapest</span>}
                        </dd>
                      </div>
                      <div className="grid gap-0.5">
                        <dt className="text-fg-faint">Time</dt>
                        <dd className="num text-[15px] text-fg">{fmtDuration(attemptDuration(v, now))}</dd>
                      </div>
                    </dl>
                    {v.changes_error && <p className="text-[11.5px] text-fg-faint">{v.changes_error}</p>}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => onOpen(v)} className="h-[28px] rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-[12.5px] text-fg hover:bg-[var(--app-row-hover)]">
                        Open
                      </button>
                      {onReview && c && (
                        <button type="button" onClick={() => onReview(v)} className="h-[28px] rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-[12.5px] text-fg hover:bg-[var(--app-row-hover)]">
                          Review changes
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
            <p className="mt-4 max-w-[720px] text-[12px] leading-relaxed text-fg-muted">
              Each attempt works in its own copy, from the same commit. Nothing is merged for you: review the one you want and commit or open a pull request from its changes; the others stay as they are until you remove their copies.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
