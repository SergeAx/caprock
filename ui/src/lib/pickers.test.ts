import { describe, expect, it } from 'vitest'
import type { SlashCommand } from './api'
import { applyPick, matchCommands, matchFiles, pickerAt } from './pickers'
import { endMention } from '@/components/TerminalKeys'

describe('pickerAt', () => {
  it('/ only at the start of the field, up to the first space', () => {
    expect(pickerAt('/', 1)).toEqual({ kind: 'slash', query: '', start: 0 })
    expect(pickerAt('/comp', 5)).toEqual({ kind: 'slash', query: 'comp', start: 0 })
    expect(pickerAt('/compact now', 12)).toBeNull()
    expect(pickerAt('use a/b', 7)).toBeNull()
    expect(pickerAt(' /x', 3)).toBeNull()
  })

  it('@ at the start of a word, not inside an address', () => {
    expect(pickerAt('@', 1)).toEqual({ kind: 'file', query: '', start: 0 })
    expect(pickerAt('see @src/ma', 11)).toEqual({ kind: 'file', query: 'src/ma', start: 4 })
    expect(pickerAt('line\n@x', 7)).toEqual({ kind: 'file', query: 'x', start: 5 })
    expect(pickerAt('me@host', 7)).toBeNull()
    expect(pickerAt('@a b', 4)).toBeNull()
    // The caret decides, not the end of the text.
    expect(pickerAt('@abc tail', 3)).toEqual({ kind: 'file', query: 'ab', start: 0 })
  })
})

describe('applyPick', () => {
  it('replaces the trigger and the word under the caret, and puts the caret after one space', () => {
    expect(applyPick('/co', { kind: 'slash', query: 'co', start: 0 }, 3, 'compact')).toEqual({ text: '/compact ', caret: 9 })
    expect(applyPick('see @ma and', { kind: 'file', query: 'ma', start: 4 }, 7, 'src/main.go'))
      .toEqual({ text: 'see @src/main.go and', caret: 17 })
    expect(applyPick('see @ma', { kind: 'file', query: 'm', start: 4 }, 6, 'src/main.go'))
      .toEqual({ text: 'see @src/main.go ', caret: 17 })
  })
})

describe('matching', () => {
  const cmds: SlashCommand[] = [
    { name: 'clear', source: 'builtin', description: 'Clear the conversation' },
    { name: 'compact', source: 'builtin' },
    { name: 'recompile', source: 'project' },
    { name: 'ship', source: 'user', description: 'Compile and ship' },
  ]
  it('commands: prefix, then contains, then description', () => {
    expect(matchCommands(cmds, 'comp').map((c) => c.name)).toEqual(['compact', 'recompile', 'ship'])
    expect(matchCommands(cmds, '').length).toBe(4)
    expect(matchCommands(cmds, 'zzz')).toEqual([])
  })
  it('files: fuzzy, capped', () => {
    const files = ['README.md', 'internal/daemon/queue.go', 'ui/src/lib/queue.ts', 'docs/app.md']
    expect(matchFiles(files, 'queue')[0]).toMatch(/queue/)
    expect(matchFiles(files, '', 2)).toEqual(['README.md', 'internal/daemon/queue.go'])
  })
})

describe('endMention', () => {
  it('a message ending in an @file gets a space, so Enter sends instead of picking from the agent\'s menu', () => {
    expect(endMention('look at @src/a.go')).toBe('look at @src/a.go ')
    expect(endMention('@a.go')).toBe('@a.go ')
    expect(endMention('mail me@x.io')).toBe('mail me@x.io')
    expect(endMention('done')).toBe('done')
  })
})
