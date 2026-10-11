/**
 * The chat field's `/` and `@` pickers (ADR-053): which one the text at the
 * caret asks for, what matches, and the text after a pick. Pure; the
 * component is `components/ChatPicker.tsx`.
 *
 * - `/` opens only at the very start of the field, as in Claude Code: a
 *   slash in the middle of a sentence is a path or a fraction.
 * - `@` opens at the start of a word: after the field's start or a space or
 *   a line break, so an e-mail address does not open it. The query runs to
 *   the caret and has no spaces.
 */
import type { SlashCommand } from './api'
import { rankFiles } from './files'

export type PickerKind = 'slash' | 'file'

export interface PickerQuery {
  kind: PickerKind
  /** What was typed after the trigger, up to the caret. */
  query: string
  /** Where the trigger character is; a pick replaces [start, caret). */
  start: number
}

/** The picker the text before the caret asks for, or null. */
export function pickerAt(text: string, caret: number): PickerQuery | null {
  const before = text.slice(0, caret)
  const slash = /^\/(\S*)$/.exec(before)
  if (slash) return { kind: 'slash', query: slash[1] ?? '', start: 0 }
  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) return { kind: 'file', query: at[2] ?? '', start: before.length - (at[2]?.length ?? 0) - 1 }
  return null
}

/** The text with [start, caret) replaced by the pick and one space, and where the caret goes. */
export function applyPick(text: string, q: PickerQuery, caret: number, value: string): { text: string; caret: number } {
  const insert = `${q.kind === 'slash' ? '/' : '@'}${value} `
  const after = text.slice(caret).replace(/^\S*/, '').replace(/^ /, '')
  const next = text.slice(0, q.start) + insert + after
  return { text: next, caret: q.start + insert.length }
}

/** The most rows a picker shows. */
export const PICKER_MAX = 50

/**
 * Commands matching what was typed: names starting with it first (the order
 * given — built-ins, the folder's, the user's), then names containing it,
 * then descriptions containing it. Case does not matter.
 */
export function matchCommands(commands: readonly SlashCommand[], query: string, limit = PICKER_MAX): SlashCommand[] {
  const q = query.toLowerCase()
  if (!q) return commands.slice(0, limit)
  const starts: SlashCommand[] = []
  const contains: SlashCommand[] = []
  const described: SlashCommand[] = []
  for (const c of commands) {
    const n = c.name.toLowerCase()
    if (n.startsWith(q)) starts.push(c)
    else if (n.includes(q)) contains.push(c)
    else if ((c.description ?? '').toLowerCase().includes(q)) described.push(c)
  }
  return [...starts, ...contains, ...described].slice(0, limit)
}

/** Files matching what was typed, fuzzily; with nothing typed, the first ones by path. */
export function matchFiles(files: readonly string[], query: string, limit = PICKER_MAX): string[] {
  if (!query) return files.slice(0, limit)
  return rankFiles(files, query, limit)
}
