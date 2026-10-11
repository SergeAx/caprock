/**
 * Sending a prompt built outside the terminal — review notes, a failure to
 * fix — to the agent working in a worktree (lib/handoff.ts): typed into the
 * running session Caprock started there, or, when there is none, the New
 * agent sheet opened in that worktree with the prompt as its first message.
 */
import { useCallback, useState } from 'react'
import { ApiError, errText } from '@/lib/api'
import { HandoffError, typePrompt } from '@/lib/handoff'

/** Who a worktree's prompts go to, from the app shell. */
export interface HandoffTarget {
  /** The running session Caprock started in the worktree, newest first; the only kind typed into (rule 7). */
  session?: { id: string; title: string }
  /** Opens New agent in the worktree with `prompt` as the first message; `onStarted` runs once it has started. */
  startAgent?: (prompt: string, onStarted?: () => void) => void
  /** Brings a session's tab to the front. */
  openSession?: (id: string) => void
}

type Result = { ok: true; to: string; id: string } | { ok: false; error: string; prompt: string; onDone?: () => void; offerNew: boolean }

export interface Handoff {
  /** What the button says: typed into a session, or a new one started. */
  label: string
  /** Whether anything can receive it. */
  available: boolean
  busy: boolean
  result: Result | null
  dismiss: () => void
  /** Sends `prompt`; `onDone` runs once it was typed in or a new agent started with it. */
  send: (prompt: string, onDone?: () => void) => Promise<void>
}

export function useHandoff(target: HandoffTarget | undefined, newLabel = 'New agent with it…'): Handoff {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const session = target?.session
  const send = useCallback(async (prompt: string, onDone?: () => void) => {
    setResult(null)
    if (session) {
      setBusy(true)
      try {
        await typePrompt(session.id, prompt)
        setResult({ ok: true, to: session.title, id: session.id })
        onDone?.()
      } catch (e) {
        const gone = e instanceof ApiError && e.status === 409
        const error = e instanceof HandoffError ? e.message : gone ? `${session.title} is no longer running here, so nothing was sent.` : `Not sent: ${errText(e)}`
        setResult({ ok: false, error, prompt, onDone, offerNew: !(e instanceof HandoffError) })
      } finally {
        setBusy(false)
      }
      return
    }
    target?.startAgent?.(prompt, onDone)
  }, [session, target])
  return {
    label: session ? 'Send to agent' : newLabel,
    available: !!session || !!target?.startAgent,
    busy,
    result,
    dismiss: () => setResult(null),
    send,
  }
}

/** What happened to the prompt: sent, with a way to the session; or not, with why and a new agent instead. */
export function HandoffResult({ handoff, target }: { handoff: Handoff; target?: HandoffTarget }) {
  const r = handoff.result
  if (!r) return null
  return (
    <div role={r.ok ? 'status' : 'alert'} className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-snug ${r.ok ? 'text-fg-muted' : 'text-danger'}`}>
      <span className="min-w-0 [overflow-wrap:anywhere]">{r.ok ? <>Sent to <span className="text-fg">{r.to}</span>.</> : r.error}</span>
      {r.ok && target?.openSession && (
        <button type="button" onClick={() => target.openSession?.(r.id)} className="rounded-[5px] px-1.5 text-[12px] text-accent hover:bg-[var(--app-row-hover)]">Open it</button>
      )}
      {!r.ok && r.offerNew && target?.startAgent && (
        <button type="button" onClick={() => { handoff.dismiss(); target.startAgent?.(r.prompt, r.onDone) }} className="rounded-[5px] px-1.5 text-[12px] text-accent hover:bg-[var(--app-row-hover)]">Start a new agent with it…</button>
      )}
      <button type="button" onClick={handoff.dismiss} aria-label="Dismiss" className="text-fg-faint hover:text-fg">×</button>
    </div>
  )
}

/**
 * "Fix with agent" on a failure that belongs to a worktree: the output goes
 * to the session Caprock started there, or to a new agent started there.
 * `prompt` is built when clicked, so a long output costs nothing until then.
 */
export function FixWithAgent({ target, prompt }: { target?: HandoffTarget; prompt: () => string }) {
  const handoff = useHandoff(target, 'Fix with a new agent…')
  if (!handoff.available) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        disabled={handoff.busy}
        onClick={() => void handoff.send(prompt())}
        title={target?.session ? `Send this to ${target.session.title} to fix` : 'No agent Caprock started is running here: start one with this as its first message'}
        className="inline-flex h-[24px] shrink-0 items-center rounded-[6px] border border-accent/60 px-2 text-[12px] font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
      >
        {handoff.busy ? 'Sending…' : target?.session ? 'Fix with agent' : handoff.label}
      </button>
      <HandoffResult handoff={handoff} target={target} />
    </div>
  )
}
