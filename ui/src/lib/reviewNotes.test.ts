import { describe, expect, it } from 'vitest'
import { unifiedRows } from './changes'
import { placeOf, quoteOf, reviewPrompt, spanOf, type ReviewNote } from './reviewNotes'
import { liveOwnedSession, plainText, promptBytes, tailOf } from './handoff'
import type { SessionSummary } from './api'

const PATCH = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'

function note(over: Partial<ReviewNote>): ReviewNote {
  return { id: 'x', path: 'f', side: 'new', start: 1, end: 1, quote: [], text: 'n', at: 0, ...over }
}

describe('review notes', () => {
  it('quotes the lines a span covers, the other side between them included', () => {
    const rows = unifiedRows(PATCH)
    expect(quoteOf(rows, spanOf('new', 3, 1))).toEqual(['  one', '- two', '+ TWO', '  three'])
    expect(quoteOf(rows, spanOf('old', 2, 2))).toEqual(['- two'])
    expect(quoteOf(rows, spanOf('new', 9, 9))).toEqual([])
  })

  it('names the place, and says when it is the old side', () => {
    expect(placeOf(note({ start: 4, end: 4 }))).toBe('f:4')
    expect(placeOf(note({ start: 4, end: 9 }))).toBe('f:4-9')
    expect(placeOf(note({ side: 'old', start: 2, end: 2 }))).toBe('f:2 (before the change)')
  })

  it('composes one prompt, notes in file and line order', () => {
    const p = reviewPrompt([
      note({ path: 'b.ts', start: 3, end: 3, quote: ['+ x'], text: 'second' }),
      note({ path: 'a.ts', start: 10, end: 12, quote: ['  y', '+ z'], text: ' first ' }),
    ], 'feat/x')
    expect(p).toBe([
      'Review notes on the uncommitted changes in feat/x. Address each one, then say briefly what you changed.',
      '1. a.ts:10-12\n```\n  y\n+ z\n```\nfirst',
      '2. b.ts:3\n```\n+ x\n```\nsecond',
    ].join('\n\n'))
  })
})

describe('handoff text', () => {
  it('drops escape sequences and control characters, and turns tabs into spaces', () => {
    expect(plainText('\x1b[31mFAIL\x1b[0m\tx\r\ny\x07')).toBe('FAIL    x\ny')
    expect(plainText('\x1b]0;title\x07ok')).toBe('ok')
  })

  it('types newlines as ESC CR', () => {
    expect(promptBytes('a\nb')).toBe('a\x1b\rb')
  })

  it('keeps the tail of a long output and says how much was cut', () => {
    const out = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    const t = tailOf(out, 100)
    expect(t.startsWith('[200 earlier lines cut]\nline 200')).toBe(true)
    expect(t.endsWith('line 299')).toBe(true)
    expect(tailOf('short\n')).toBe('short')
    const wide = tailOf('x'.repeat(50) + '\n' + 'y'.repeat(50), 100, 60)
    expect(wide).toBe('[1 earlier line cut]\n' + 'y'.repeat(50))
  })

  it('offers only a running session Caprock started, never a shell', () => {
    const s = (over: Partial<SessionSummary>) => ({ session_id: 'a', owned: true, status: 'active', ...over }) as SessionSummary
    expect(liveOwnedSession([s({ session_id: 'sh', kind: 'shell' }), s({ session_id: 'ext', owned: false }), s({ session_id: 'old', status: 'ended' }), s({ session_id: 'ok' })])?.session_id).toBe('ok')
    expect(liveOwnedSession([s({ detached: true })])).toBeUndefined()
  })
})
