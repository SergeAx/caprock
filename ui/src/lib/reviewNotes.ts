/**
 * Review notes on a worktree's diff (.ai/04-ui.md § Changes view): a short
 * note on a line or a range of lines, kept per worktree in localStorage until
 * they are sent to an agent as one prompt, then cleared.
 *
 * A note carries the lines it was written on, quoted when it was made, so the
 * prompt still says what was meant after the agent has changed the file.
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { UnifiedRow } from './changes'

/** Which side of the diff a line number counts on: the file as it is now, or as it was. */
export type NoteSide = 'new' | 'old'

export interface LineSpan {
  side: NoteSide
  start: number
  end: number
}

export interface ReviewNote extends LineSpan {
  id: string
  path: string
  /** The diff lines it was written on, each with its +, − or space. */
  quote: string[]
  text: string
  at: number
}

/** Lines of code quoted per note, at most; the rest is counted. */
export const QUOTE_MAX = 40

const PREFIX = 'caprock.review.'

/** The key a worktree's notes are kept under. */
export function notesKey(projectId: string, worktree: string): string {
  return `${projectId}:${worktree}`
}

// --- the store: one list per worktree, shared by every view of it ---

const cache = new Map<string, ReviewNote[]>()
const listeners = new Map<string, Set<() => void>>()
const EMPTY: ReviewNote[] = []

function read(key: string): ReviewNote[] {
  const held = cache.get(key)
  if (held) return held
  let list: ReviewNote[] = EMPTY
  try {
    const raw = localStorage.getItem(PREFIX + key)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) list = parsed.filter(isNote)
  } catch { /* nothing kept */ }
  cache.set(key, list)
  return list
}

function isNote(v: unknown): v is ReviewNote {
  const n = v as ReviewNote
  return !!n && typeof n.id === 'string' && typeof n.path === 'string' && typeof n.text === 'string'
    && typeof n.start === 'number' && typeof n.end === 'number' && (n.side === 'new' || n.side === 'old') && Array.isArray(n.quote)
}

function write(key: string, list: ReviewNote[]): void {
  cache.set(key, list)
  try {
    if (list.length) localStorage.setItem(PREFIX + key, JSON.stringify(list))
    else localStorage.removeItem(PREFIX + key)
  } catch { /* kept for this page only */ }
  listeners.get(key)?.forEach((l) => l())
}

/** Drops every note of a worktree: they were sent. */
export function clearNotes(key: string): void {
  write(key, EMPTY)
}

/** Forgets what was read, for tests. */
export function resetNotesCache(): void {
  cache.clear()
}

export interface NotesApi {
  notes: ReviewNote[]
  add: (n: Omit<ReviewNote, 'id' | 'at'>) => void
  update: (id: string, change: Partial<Pick<ReviewNote, 'text' | 'side' | 'start' | 'end' | 'quote'>>) => void
  remove: (id: string) => void
  clear: () => void
}

/** A worktree's notes, live across every view of it. */
export function useReviewNotes(key: string): NotesApi {
  const subscribe = useCallback((l: () => void) => {
    let set = listeners.get(key)
    if (!set) listeners.set(key, (set = new Set()))
    set.add(l)
    return () => { set!.delete(l) }
  }, [key])
  const get = useCallback(() => read(key), [key])
  const notes = useSyncExternalStore(subscribe, get, get)
  const add = useCallback((n: Omit<ReviewNote, 'id' | 'at'>) => {
    const note: ReviewNote = { ...n, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now() }
    write(key, sortNotes([...read(key), note]))
  }, [key])
  const update = useCallback((id: string, change: Partial<Pick<ReviewNote, 'text' | 'side' | 'start' | 'end' | 'quote'>>) => {
    write(key, sortNotes(read(key).map((n) => (n.id === id ? { ...n, ...change } : n))))
  }, [key])
  const remove = useCallback((id: string) => {
    write(key, read(key).filter((n) => n.id !== id))
  }, [key])
  const clear = useCallback(() => clearNotes(key), [key])
  return { notes, add, update, remove, clear }
}

/** By file, then by line: the order a reader goes through a diff. */
export function sortNotes(list: ReviewNote[]): ReviewNote[] {
  return [...list].sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start || a.end - b.end || a.at - b.at)
}

// --- lines ---

/** The number a row has on `side`, when it has one there. */
export function lineOf(r: Pick<UnifiedRow, 'kind' | 'old' | 'new'>, side: NoteSide): number | undefined {
  if (r.kind !== 'add' && r.kind !== 'del' && r.kind !== 'ctx') return undefined
  return side === 'new' ? r.new : r.old
}

/** Whether a row's line on `side` falls inside `span`. */
export function inSpan(r: Pick<UnifiedRow, 'kind' | 'old' | 'new'>, span: LineSpan | null | undefined): boolean {
  if (!span) return false
  const n = lineOf(r, span.side)
  return n !== undefined && n >= span.start && n <= span.end
}

/** A span from a first click and a shift-click, either order. */
export function spanOf(side: NoteSide, a: number, b: number): LineSpan {
  return { side, start: Math.min(a, b), end: Math.max(a, b) }
}

/**
 * The diff lines a span covers, quoted: from the first row whose line is in
 * the span to the last, the other side's lines between them included, each
 * with its marker. Long spans keep their first QUOTE_MAX lines.
 */
export function quoteOf(rows: readonly UnifiedRow[], span: LineSpan): string[] {
  let first = -1
  let last = -1
  rows.forEach((r, i) => {
    if (inSpan(r, span)) {
      if (first < 0) first = i
      last = i
    }
  })
  if (first < 0) return []
  const out = rows.slice(first, last + 1)
    .filter((r) => r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx')
    .map((r) => `${r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '} ${r.text}`)
  if (out.length > QUOTE_MAX) return [...out.slice(0, QUOTE_MAX), `… ${out.length - QUOTE_MAX} more lines`]
  return out
}

/** `path:12` or `path:12-18`, and which side when it is the old one. */
export function placeOf(n: Pick<ReviewNote, 'path' | 'side' | 'start' | 'end'>): string {
  const lines = n.end > n.start ? `${n.start}-${n.end}` : `${n.start}`
  return `${n.path}:${lines}${n.side === 'old' ? ' (before the change)' : ''}`
}

/**
 * The one prompt the notes become: for each, where it is, the code it is on,
 * and the note.
 */
export function reviewPrompt(notes: readonly ReviewNote[], where?: string): string {
  const list = sortNotes([...notes])
  const head = `Review notes on the uncommitted changes${where ? ` in ${where}` : ''}. Address each one, then say briefly what you changed.`
  const items = list.map((n, i) => {
    const quote = n.quote.length ? `\n\`\`\`\n${n.quote.join('\n')}\n\`\`\`` : ''
    return `${i + 1}. ${placeOf(n)}${quote}\n${n.text.trim()}`
  })
  return [head, ...items].join('\n\n')
}
