/**
 * Saved prompts and commands (ADR-051): a name and a text, for every project
 * or for one, kept by the daemon so a paired phone sees the same list.
 *
 * - A **prompt** is typed into a session Caprock started, through the same
 *   input path as the keyboard: the text, then Enter on its own (the chat's
 *   `deliver`). Never into a session Caprock did not start (rule 7).
 * - A **command** is one line, typed and run in a new shell tab in the
 *   folder in front — the session's worktree, else the project's root.
 *
 * Changed only on the machine (Settings → Saved prompts and commands); the
 * daemon refuses a paired device's write whatever this page draws.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api, type SavedDraft, type SavedPrompt } from './api'

export type SavedKind = SavedPrompt['kind']
export type { SavedDraft, SavedPrompt }

/** The daemon's limits, repeated here so the form can say them before a save. */
export const SAVED_NAME_MAX = 80
export const SAVED_PROMPT_BYTES = 8 << 10
export const SAVED_COMMAND_BYTES = 1 << 10

export const savedApi = {
  list: (sessionId?: string) => api.savedPrompts(sessionId),
  add: (d: SavedDraft) => api.addSavedPrompt(d),
  update: (id: number, d: Partial<SavedDraft>) => api.updateSavedPrompt(id, d),
  remove: (id: number) => api.removeSavedPrompt(id),
}

/** A newline inside a prompt: ESC CR, what a terminal sends for Alt+Enter (TerminalKeys). */
const NEWLINE = '\x1b\r'
/** The pause between the text and the Enter that submits it (TerminalKeys). */
const SUBMIT_DELAY_MS = 80

/**
 * Types a saved prompt into a session Caprock started and submits it: the
 * text, then Enter on its own after a beat, as the message field does. The
 * daemon refuses a session it did not start (rule 7).
 */
export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  await api.agentInput(sessionId, text.replace(/\r?\n/g, NEWLINE))
  await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS))
  await api.agentInput(sessionId, '\r')
}

/** Bytes of a string as UTF-8, as the daemon counts them. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/** What is wrong with a draft, or '' — the daemon's own checks, said first. */
export function draftProblem(d: SavedDraft): string {
  const name = d.name.trim()
  const text = d.text.trim()
  if (!name) return 'Give it a name.'
  if ([...name].length > SAVED_NAME_MAX) return `The name is longer than ${SAVED_NAME_MAX} characters.`
  if (!text) return d.kind === 'command' ? 'The command is empty.' : 'The prompt is empty.'
  if (d.kind === 'command') {
    if (/[\r\n]/.test(text)) return 'A command is one line; chain several with && or ;.'
    if (utf8Bytes(text) > SAVED_COMMAND_BYTES) return `The command is longer than ${SAVED_COMMAND_BYTES} bytes.`
  } else if (utf8Bytes(text) > SAVED_PROMPT_BYTES) {
    return `The prompt is longer than ${SAVED_PROMPT_BYTES >> 10} KiB.`
  }
  return ''
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Whether dir is root or below it, on segment boundaries (store.DirWithin). */
export function dirWithin(dir: string, root: string): boolean {
  const d = norm(dir)
  const r = norm(root)
  if (!d || !r) return false
  return d === r || d.startsWith(`${r}/`)
}

/** The ones for every project and the ones of the project holding `dir` (or with id `projectId`). */
export function savedFor(items: readonly SavedPrompt[], scope: { dir?: string; projectId?: string }): SavedPrompt[] {
  return items.filter((v) => !v.project_id
    || (scope.projectId !== undefined && String(v.project_id) === scope.projectId)
    || (!!scope.dir && !!v.project_root && dirWithin(scope.dir, v.project_root)))
}

// ── One shared list per page ────────────────────────────────────────────
//
// Settings, the palette and the chips read the same list; a change made in
// one is seen by the others at once. A paired phone reads it when a view
// opens; it never writes.

interface State {
  items: SavedPrompt[]
  loaded: boolean
  error: string
  /** Bumped on every change made here, so per-session lists fetch again. */
  version: number
}

let state: State = { items: [], loaded: false, error: '', version: 0 }
const subs = new Set<() => void>()
let inflight: Promise<void> | null = null

function set(next: Partial<State>) {
  state = { ...state, ...next }
  for (const f of subs) f()
}

/** Fetch the list again. */
export function reloadSaved(): Promise<void> {
  if (inflight) return inflight
  inflight = savedApi.list()
    .then((r) => set({ items: Array.isArray(r.items) ? r.items : [], loaded: true, error: '' }))
    .catch((e: unknown) => set({ loaded: true, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => { inflight = null })
  return inflight
}

/** After a change here: the new list, and every per-session list asked again. */
export function savedChanged(items: SavedPrompt[]): void {
  set({ items, loaded: true, error: '', version: state.version + 1 })
}

export function savedSnapshot(): State {
  return state
}

/** For tests. */
export function resetSaved(): void {
  state = { items: [], loaded: false, error: '', version: 0 }
  inflight = null
}

/**
 * The whole list, fetched once per page and kept current by changes made
 * here. `fresh` asks the daemon again on mount — Settings does, so a change
 * made in another window is not edited over.
 */
export function useSavedPrompts(fresh = false): State {
  const s = useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f) } },
    () => state,
  )
  useEffect(() => { if (fresh || !state.loaded) void reloadSaved() }, [fresh])
  return s
}

/** The prompts for one session — every project's and its own project's — asked of the daemon. */
export function useSavedPromptsFor(sessionId: string | undefined): SavedPrompt[] {
  const version = useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f) } },
    () => state.version,
  )
  const [items, setItems] = useState<SavedPrompt[]>([])
  useEffect(() => {
    if (!sessionId) { setItems([]); return }
    let alive = true
    savedApi.list(sessionId)
      .then((r) => { if (alive) setItems((Array.isArray(r.items) ? r.items : []).filter((v) => v.kind === 'prompt')) })
      .catch(() => { if (alive) setItems([]) })
    return () => { alive = false }
  }, [sessionId, version])
  return items
}
