/**
 * One file's diff, unified or side by side, drawn a screenful at a time.
 *
 * Only the rows in view (plus a margin) are in the DOM, so a 5,000-line patch
 * scrolls like a 50-line one (21-app.md § The scrolling rule). Unified rows
 * are one line each and scroll sideways together. Side by side, each half is
 * half the width and its lines wrap; the font is monospaced, so how many rows
 * a line wraps to is known from its length before it is drawn, and the
 * window of rows is still computed rather than measured. Lines past
 * LONG_LINE characters are cut with a note.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { splitRows, unifiedRows, type SideCell, type SplitRow, type UnifiedRow } from '@/lib/changes'
import { inSpan, type LineSpan, type NoteSide, type ReviewNote } from '@/lib/reviewNotes'
import { NOTE_EDITOR_HEIGHT, NoteCard, NoteEditor, noteHeight } from './ReviewNotes'

export const ROW_HEIGHT = 18
/** Pixels drawn above and below the view. */
const OVERSCAN_PX = 600
const LONG_LINE = 2000
const TAB = 4

export type DiffLayout = 'unified' | 'split'

const TONE: Record<string, string> = {
  add: 'bg-ok/12',
  del: 'bg-danger/12',
  ctx: '',
  hunk: 'bg-info/8 text-info',
  meta: 'text-fg-faint',
}

function cut(text: string): string {
  return text.length > LONG_LINE ? `${text.slice(0, LONG_LINE)} … ${(text.length - LONG_LINE).toLocaleString()} more characters` : text
}

/** Columns a line takes, tabs at their width. */
function columns(text: string): number {
  const t = cut(text)
  let n = t.length
  for (let i = t.indexOf('\t'); i >= 0; i = t.indexOf('\t', i + 1)) n += TAB - 1
  return n
}

/** The first index whose offset is past y (offsets ascending, offsets[0] = 0). */
function rowAt(offsets: Float64Array, y: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1]! <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Review notes on this file's lines (.ai/04-ui.md § Changes view): drawn under the line they end on. */
export interface DiffNotes {
  /** This file's notes. */
  notes: ReviewNote[]
  /** The note being written or edited, and the lines it covers. */
  draft: (LineSpan & { id?: string; text: string }) | null
  /** A line number was clicked; `extend` (shift) makes a range with the draft's first line. */
  onLine: (side: NoteSide, n: number, extend: boolean) => void
  onEdit: (note: ReviewNote) => void
  onRemove: (id: string) => void
  onDraftText: (text: string) => void
  onSave: () => void
  onCancel: () => void
  /** A note to scroll to; `n` counts the asks, so the same note can be asked for again. */
  focus?: { id: string; n: number }
}

/** A drawn row that is not a line of the diff: a note under its line, or the one being written. */
type NoteRow = { kind: 'note'; note: ReviewNote } | { kind: 'draft' }
type Drawn = UnifiedRow | SplitRow | NoteRow

/** The line a row ends on, on `side`, in either layout. */
function endLine(r: UnifiedRow | SplitRow, side: NoteSide): number | undefined {
  if (r.kind === 'line') {
    const c = side === 'new' ? r.right : r.left
    return c && (side === 'new' ? c.kind !== 'del' : c.kind !== 'add') ? c.n : undefined
  }
  if (r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx') return side === 'new' ? r.new : r.old
  return undefined
}

/** The rows with each note (and the draft) placed after the line it ends on; a note whose line is no longer in the diff is not drawn here. */
function withNotes(rows: (UnifiedRow | SplitRow)[], notes?: DiffNotes): Drawn[] {
  if (!notes || (notes.notes.length === 0 && !notes.draft)) return rows
  const after = new Map<string, NoteRow[]>()
  const put = (side: NoteSide, n: number, row: NoteRow) => {
    const k = `${side}:${n}`
    after.set(k, [...(after.get(k) ?? []), row])
  }
  for (const n of notes.notes) {
    if (notes.draft?.id === n.id) continue
    put(n.side, n.end, { kind: 'note', note: n })
  }
  if (notes.draft) put(notes.draft.side, notes.draft.end, { kind: 'draft' })
  const out: Drawn[] = []
  for (const r of rows) {
    out.push(r)
    for (const side of ['new', 'old'] as const) {
      const n = endLine(r, side)
      const extra = n !== undefined ? after.get(`${side}:${n}`) : undefined
      if (extra) { out.push(...extra); after.delete(`${side}:${n}`) }
    }
  }
  return out
}

export interface DiffViewProps {
  patch: string
  layout: DiffLayout
  /** Draws a button on each hunk header: stage or unstage that hunk. */
  hunkAction?: { label: string; run: (index: number) => void; busy?: boolean }
  /** Scrolled back to the top when this changes (a new file). */
  resetKey?: string
  /** Review notes: line numbers become buttons that start one. */
  notes?: DiffNotes
}

export const DiffView = memo(function DiffView({ patch, layout, hunkAction, resetKey, notes }: DiffViewProps) {
  const unified = useMemo(() => unifiedRows(patch), [patch])
  const lines: (UnifiedRow | SplitRow)[] = useMemo(() => (layout === 'split' ? splitRows(unified) : unified), [layout, unified])
  const rows = useMemo(() => withNotes(lines, notes), [lines, notes])
  // Lines a note covers: their numbers are marked.
  const noted = useMemo(() => {
    const set = new Set<string>()
    for (const n of notes?.notes ?? []) for (let i = n.start; i <= n.end && i - n.start < 2000; i++) set.add(`${n.side}:${i}`)
    return set
  }, [notes?.notes])
  const digits = useMemo(() => String(unified.reduce((m, r) => Math.max(m, r.old ?? 0, r.new ?? 0), 0)).length, [unified])
  const longest = useMemo(() => Math.min(LONG_LINE + 30, unified.reduce((m, r) => Math.max(m, r.text.length), 0)), [unified])

  const box = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const [top, setTop] = useState(0)
  const [size, setSize] = useState({ width: 900, height: 600 })
  const [ch, setCh] = useState(7.2)
  const frame = useRef(0)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth || 900, height: el.clientHeight || 600 })
    measure()
    const w = probe.current?.getBoundingClientRect().width
    if (w) setCh(w / 100)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0
    setTop(0)
  }, [resetKey])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // Scroll a note asked for (from the notes bar) into the upper third of the view.
  const focusAsk = notes?.focus
  useEffect(() => {
    if (!focusAsk || !box.current) return
    const i = rows.findIndex((r) => r.kind === 'note' && r.note.id === focusAsk.id)
    if (i < 0) return
    box.current.scrollTop = Math.max(0, offsets[i]! - size.height / 3)
    setTop(box.current.scrollTop)
  }, [focusAsk?.id, focusAsk?.n]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setTop(box.current?.scrollTop ?? 0))
  }, [])

  // Pixel widths: the gutter is the widest line number plus padding (0.9rem).
  const gutterPx = digits * ch + 14.4
  const halfPx = Math.max(120, (size.width - 1) / 2)
  // Characters that fit on one row of a half: its width less the gutter and
  // the right padding (pr-4).
  const perRow = Math.max(8, Math.floor((halfPx - gutterPx - 16) / ch))

  // A note is drawn across the view, from the code's column.
  const noteInset = layout === 'split' ? gutterPx + 8 : 2 * gutterPx + 8
  const noteWidth = Math.max(160, size.width - noteInset - 16)

  const offsets = useMemo(() => {
    const out = new Float64Array(rows.length + 1)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      if (r.kind === 'note' || r.kind === 'draft') {
        out[i + 1] = out[i]! + (r.kind === 'draft' ? NOTE_EDITOR_HEIGHT : noteHeight(r.note.text, noteWidth, ch))
        continue
      }
      let lines = 1
      if (layout === 'split' && r.kind === 'line') {
        const s = r as Extract<SplitRow, { kind: 'line' }>
        lines = Math.max(1, Math.ceil(columns(s.left?.text ?? '') / perRow), Math.ceil(columns(s.right?.text ?? '') / perRow))
      }
      out[i + 1] = out[i]! + lines * ROW_HEIGHT
    }
    return out
  }, [rows, layout, perRow, noteWidth, ch])

  const total = offsets[rows.length]!
  const first = rowAt(offsets, Math.max(0, top - OVERSCAN_PX))
  const last = Math.min(rows.length, rowAt(offsets, top + size.height + OVERSCAN_PX) + 1)
  const gutter = `${gutterPx}px`
  // Unified: one column of text as wide as the longest line, so the
  // sideways scroll does not jump as rows come and go.
  const width = layout === 'split' ? '100%' : `${2 * gutterPx + (longest + 3) * ch + 24}px`

  return (
    <div
      ref={box}
      onScroll={onScroll}
      tabIndex={0}
      role="region"
      aria-label="Diff"
      className={`app-scroll mono relative h-full min-h-0 text-[12px] leading-[18px] outline-none [tab-size:4] ${layout === 'split' ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto'}`}
    >
      <span ref={probe} aria-hidden className="pointer-events-none invisible absolute whitespace-pre">{'0'.repeat(100)}</span>
      <div style={{ height: total, minWidth: '100%', width }} className="relative">
        <div style={{ transform: `translateY(${offsets[first]}px)` }}>
          {rows.slice(first, last).map((r, i) => {
            const key = first + i
            const h = offsets[key + 1]! - offsets[key]!
            if (r.kind === 'note' || r.kind === 'draft') {
              return (
                <div key={key} style={{ height: h, width: noteWidth + noteInset, paddingLeft: noteInset }} className="sticky left-0 overflow-hidden py-[4px] font-sans">
                  {r.kind === 'note' ? (
                    <NoteCard note={r.note} onEdit={() => notes?.onEdit(r.note)} onRemove={() => notes?.onRemove(r.note.id)} />
                  ) : notes?.draft ? (
                    <NoteEditor draft={notes.draft} onText={notes.onDraftText} onSave={notes.onSave} onCancel={notes.onCancel} />
                  ) : null}
                </div>
              )
            }
            if (r.kind === 'hunk' || r.kind === 'meta') {
              return (
                <div key={key} className={`flex h-[18px] items-center overflow-hidden whitespace-pre ${TONE[r.kind]}`}>
                  {r.kind === 'hunk' && hunkAction && (
                    <button
                      type="button"
                      disabled={hunkAction.busy}
                      onClick={() => hunkAction.run(r.hunk)}
                      className="sticky left-0 z-[1] mx-1 h-[16px] shrink-0 rounded-[4px] border border-[var(--app-hairline-strong)] bg-panel px-1.5 font-sans text-[10.5px] leading-none text-fg-muted hover:text-fg disabled:opacity-50"
                    >
                      {hunkAction.label}
                    </button>
                  )}
                  <span className="px-2">{r.text}</span>
                </div>
              )
            }
            if (layout === 'split') {
              const s = r as Extract<SplitRow, { kind: 'line' }>
              return (
                <div key={key} className="flex overflow-hidden" style={{ height: h }}>
                  <Side cell={s.left} gutter={gutter} side="old" notes={notes} noted={noted} />
                  <div className="w-px shrink-0 bg-[var(--app-hairline)]" />
                  <Side cell={s.right} gutter={gutter} side="new" notes={notes} noted={noted} />
                </div>
              )
            }
            const u = r as UnifiedRow
            return (
              <div key={key} className={`flex h-[18px] ${TONE[u.kind]} ${inSpan(u, notes?.draft) ? 'shadow-[inset_3px_0_0_var(--color-accent)] !bg-accent/15' : ''}`}>
                <LineNo n={u.old} side="old" width={gutter} pad="pr-1.5" notes={notes} noted={noted} />
                <LineNo n={u.new} side="new" width={gutter} pad="pr-2" notes={notes} noted={noted} />
                <span className={`select-none pr-1 ${u.kind === 'add' ? 'text-ok' : u.kind === 'del' ? 'text-danger' : 'text-fg-faint'}`}>{u.kind === 'add' ? '+' : u.kind === 'del' ? '−' : ' '}</span>
                <span className={`whitespace-pre pr-4 ${u.kind === 'ctx' ? 'text-fg-muted' : 'text-fg'}`}>{cut(u.text)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})

/**
 * A line number. With notes on, a button: a click starts a note on the line,
 * a shift-click stretches the one being written to it.
 */
function LineNo({ n, side, width, pad, notes, noted }: { n?: number; side: NoteSide; width: string; pad: string; notes?: DiffNotes; noted: Set<string> }) {
  const cls = `shrink-0 select-none text-right ${pad} ${n && noted.has(`${side}:${n}`) ? 'font-semibold text-accent' : 'text-fg-faint'}`
  if (!n || !notes) return <span className={cls} style={{ width }}>{n || ''}</span>
  return (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }}
      onClick={(e) => notes.onLine(side, n, e.shiftKey)}
      title={`Add a note on line ${n}${side === 'old' ? ' (before the change)' : ''}; ⇧-click to cover a range`}
      aria-label={`Note on line ${n}${side === 'old' ? ', before the change' : ''}`}
      className={`${cls} cursor-pointer hover:bg-accent/15 hover:text-accent`}
      style={{ width }}
    >
      {n}
    </button>
  )
}

/** One half of a side-by-side row; it wraps by characters, so its height is what the row was given. */
function Side({ cell, gutter, side, notes, noted }: { cell?: SideCell; gutter: string; side: NoteSide; notes?: DiffNotes; noted: Set<string> }) {
  if (!cell) return <div className="min-w-0 flex-1 basis-0 bg-[var(--app-row-hover)]" />
  const d = notes?.draft
  const marked = !!d && d.side === side && cell.n >= d.start && cell.n <= d.end && (side === 'new' ? cell.kind !== 'del' : cell.kind !== 'add')
  return (
    <div className={`flex min-w-0 flex-1 basis-0 ${TONE[cell.kind]} ${marked ? 'shadow-[inset_3px_0_0_var(--color-accent)] !bg-accent/15' : ''}`}>
      <LineNo n={cell.n || undefined} side={side} width={gutter} pad="pr-2" notes={notes} noted={noted} />
      <span className={`min-w-0 flex-1 whitespace-pre-wrap break-all pr-4 ${cell.kind === 'ctx' ? 'text-fg-muted' : 'text-fg'}`}>{cut(cell.text)}</span>
    </div>
  )
}
