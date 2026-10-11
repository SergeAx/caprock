/**
 * Review notes in the Changes view (lib/reviewNotes.ts): a note under the
 * line it is on, the box a note is written in, and the bar that counts them
 * and sends them to the agent as one prompt.
 *
 * A note's text is monospaced, like the diff around it, so its height is
 * known from its length before it is drawn and the diff's rows stay computed
 * rather than measured (DiffView.tsx).
 */
import { useEffect, useRef, useState } from 'react'
import { placeOf, type LineSpan, type ReviewNote } from '@/lib/reviewNotes'
import { keys } from '@/lib/appkeys'
import { HandoffResult, type Handoff, type HandoffTarget } from './AgentHandoff'

const LINE = 18
/** A note's frame: 4 px above and below, a 1 px border, 5 px padding, and its 18 px header. */
const NOTE_FRAME = 4 + 1 + 5 + LINE + 5 + 1 + 4
/** The box a note is written in: three lines of text and a row of buttons. */
export const NOTE_EDITOR_HEIGHT = 4 + 1 + 6 + (3 * LINE + 10) + 6 + 24 + 6 + 1 + 4

/** The height a note takes, `width` px wide with characters `ch` px wide. */
export function noteHeight(text: string, width: number, ch: number): number {
  const perRow = Math.max(8, Math.floor((width - 22) / ch))
  const lines = text.split('\n').reduce((sum, p) => sum + wrappedLines(p, perRow), 0)
  return NOTE_FRAME + lines * LINE
}

/**
 * Rows a paragraph takes at `perRow` monospace columns, wrapped as the
 * browser wraps it: at spaces, a word longer than a row broken anywhere, the
 * spaces at a break hanging past the edge.
 */
export function wrappedLines(p: string, perRow: number): number {
  let rows = 1
  let col = 0
  for (const word of p.split(/(?<= )/)) {
    const bare = word.trimEnd().length
    if (col > 0 && col + bare > perRow) { rows += 1; col = 0 }
    let w = word.length
    while (col === 0 && w - (word.length - bare) > perRow) { rows += 1; w -= perRow }
    col += w
  }
  return rows
}

export function NoteCard({ note, onEdit, onRemove }: { note: ReviewNote; onEdit: () => void; onRemove: () => void }) {
  return (
    <div className="h-full overflow-hidden rounded-[7px] border border-accent/45 bg-panel px-2.5 py-[5px]" data-note={note.id}>
      <div className="flex h-[18px] items-center gap-2 text-[11.5px] leading-[18px]">
        <span className="font-medium text-accent">Note</span>
        <span className="mono min-w-0 truncate text-fg-faint">{placeOf(note)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={onEdit} className="rounded-[4px] px-1.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Edit</button>
          <button type="button" onClick={onRemove} aria-label={`Delete the note on ${placeOf(note)}`} className="rounded-[4px] px-1.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-danger">Delete</button>
        </span>
      </div>
      <p className="mono whitespace-pre-wrap text-[12px] [overflow-wrap:anywhere] leading-[18px] text-fg">{note.text}</p>
    </div>
  )
}

/** Enter saves, ⇧Enter starts a new line, Esc cancels. */
export function NoteEditor({ draft, onText, onSave, onCancel }: {
  draft: LineSpan & { id?: string; text: string }
  onText: (t: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { box.current?.focus({ preventScroll: true }) }, [draft.start, draft.end, draft.side, draft.id])
  const lines = draft.end > draft.start ? `lines ${draft.start}–${draft.end}` : `line ${draft.start}`
  return (
    <div className="flex h-full flex-col gap-[6px] overflow-hidden rounded-[7px] border border-accent/60 bg-panel px-2.5 py-[6px]">
      <textarea
        ref={box}
        value={draft.text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); onSave() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
        }}
        placeholder={`A note on ${lines}${draft.side === 'old' ? ' (before the change)' : ''} — what should the agent do here?`}
        aria-label={`Note on ${lines}`}
        rows={3}
        className="mono h-[64px] w-full shrink-0 resize-none rounded-[6px] border border-[var(--app-hairline-strong)] bg-bg px-2 py-[4px] text-[12px] leading-[18px] text-fg placeholder:font-sans placeholder:text-fg-faint focus:border-accent focus:outline-none"
      />
      <div className="flex h-[24px] items-center gap-2 text-[11.5px]">
        <span className="min-w-0 truncate text-fg-faint">⇧-click a line number for a range · Enter saves · Esc cancels</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={onCancel} className="inline-flex h-[24px] items-center rounded-[6px] px-2 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Cancel</button>
          <button type="button" disabled={!draft.text.trim()} onClick={onSave} className="inline-flex h-[24px] items-center rounded-[6px] bg-accent px-2.5 font-medium text-panel hover:brightness-110 disabled:opacity-40">
            {draft.id ? 'Save' : 'Add note'}
          </button>
        </span>
      </div>
    </div>
  )
}

/**
 * Under the diff while there are notes: how many, the list of them, Clear,
 * and Send to agent (⇧⌘↵ anywhere in the view).
 */
export function NotesBar({ notes, handoff, target, onSend, onClear, onJump, onRemove }: {
  notes: ReviewNote[]
  handoff: Handoff
  target?: HandoffTarget
  onSend: () => void
  onClear: () => void
  onJump: (n: ReviewNote) => void
  onRemove: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  if (notes.length === 0 && !handoff.result) return null
  const files = new Set(notes.map((n) => n.path)).size
  return (
    <div className="shrink-0 border-t border-[var(--app-hairline)] bg-[var(--app-chrome-bg)]" aria-label="Review notes">
      {open && notes.length > 0 && (
        <ul className="app-scroll max-h-[180px] overflow-y-auto border-b border-[var(--app-hairline)] py-1" aria-label="Notes">
          {notes.map((n) => (
            <li key={n.id} className="group flex min-w-0 items-center gap-2 px-4 py-[3px] text-[12px]">
              <button type="button" onClick={() => onJump(n)} className="mono shrink-0 text-fg-muted hover:text-accent hover:underline" title="Show it in the diff">{placeOf(n)}</button>
              <span className="min-w-0 flex-1 truncate text-fg" title={n.text}>{n.text}</span>
              <button type="button" onClick={() => onRemove(n.id)} aria-label={`Delete the note on ${placeOf(n)}`} className="shrink-0 px-1 text-fg-faint hover:text-danger">×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-h-[40px] flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-1.5">
        {notes.length > 0 && (
          <>
            <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 rounded-[6px] px-1.5 text-[12.5px] text-fg hover:bg-[var(--app-row-hover)]">
              <span aria-hidden className="inline-block h-[7px] w-[7px] rounded-full bg-accent" />
              {notes.length} note{notes.length === 1 ? '' : 's'}{files > 1 ? ` on ${files} files` : ''}
              <span className="text-[11px] text-fg-faint">{open ? 'Hide' : 'Show'}</span>
            </button>
            {confirm ? (
              <span className="flex items-center gap-1.5 text-[12px] text-fg-muted">
                Delete every note?
                <button type="button" autoFocus onClick={() => { setConfirm(false); onClear() }} className="rounded-[5px] px-1.5 text-danger hover:bg-[var(--app-row-hover)]">Delete</button>
                <button type="button" onClick={() => setConfirm(false)} className="rounded-[5px] px-1.5 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Keep</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirm(true)} className="rounded-[5px] px-1.5 text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Clear</button>
            )}
          </>
        )}
        <div className="min-w-0 flex-1"><HandoffResult handoff={handoff} target={target} /></div>
        {notes.length > 0 && handoff.available && (
          <button
            type="button"
            disabled={handoff.busy}
            onClick={onSend}
            title={target?.session ? `Type them into ${target.session.title} as one prompt (${keys('⇧⌘↵')})` : `No agent Caprock started is running here: start one with the notes as its first message (${keys('⇧⌘↵')})`}
            className="h-[28px] shrink-0 rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50"
          >
            {handoff.busy ? 'Sending…' : handoff.label}
          </button>
        )}
      </div>
    </div>
  )
}
