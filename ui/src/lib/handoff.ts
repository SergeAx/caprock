/**
 * Handing work to an agent from outside its terminal: review notes on a diff
 * and a failure to fix go to the session working in that worktree, typed in
 * as a prompt and submitted — or, when there is none Caprock can type into,
 * to a new agent started there (.ai/04-ui.md § Changes view).
 *
 * Rule 7 holds twice. The caller offers a session only when Caprock started
 * it and it is still running (`liveOwnedSession`), and the daemon refuses
 * input for any other id anyway (`POST /v1/agents/{id}/input`, ErrNotOwned).
 * And nothing is typed while the session waits on a permission prompt: the
 * text would land in the agent's menu and pick an answer.
 */
import { api } from './api'
import { NEWLINE } from './xtermInput'
import type { SessionSummary } from './api'

/** How long to wait between the text and the Enter that submits it. Sent in
 *  one write, a TUI reads the pair as a paste and keeps the Enter as a line. */
export const SUBMIT_DELAY_MS = 80

/** The pause before Enter for a prompt of `n` characters: a long paste takes
 *  the agent's input box longer to take in, and an Enter that arrives while it
 *  does is read as part of the paste. */
export function submitDelay(n: number): number {
  return Math.min(500, SUBMIT_DELAY_MS + Math.round(n / 50))
}

/**
 * Text made safe to type into a terminal agent: escape sequences and control
 * characters are dropped (an ESC in a hook's coloured output would be read as
 * a key), tabs become spaces (Tab completes in Claude Code), line endings are
 * one \n.
 */
export function plainText(s: string): string {
  return s
    // CSI and OSC sequences, then any other two-byte escape.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/** The bytes that type `prompt` as one message: its newlines as ESC CR, which the agents read as a line inside the prompt. */
export function promptBytes(prompt: string): string {
  return plainText(prompt).replace(/\n/g, NEWLINE)
}

/** Why a prompt was not typed in. */
export class HandoffError extends Error {}

/**
 * Types `prompt` into a session Caprock started and submits it. Refuses while
 * the session waits on a permission prompt.
 */
export async function typePrompt(sessionId: string, prompt: string): Promise<void> {
  const waiting = await api.permission(sessionId).then((r) => r.permission !== null).catch(() => false)
  if (waiting) throw new HandoffError('The agent is waiting on a permission prompt. Answer it first, then send again.')
  const bytes = promptBytes(prompt)
  await api.agentInput(sessionId, bytes)
  await new Promise((r) => window.setTimeout(r, submitDelay(bytes.length)))
  await api.agentInput(sessionId, '\r')
}

/**
 * The session a prompt for this worktree goes to: the most recent agent
 * session (not a shell) that Caprock started and that is still running —
 * the only kind it may type into. `sessions` is newest first.
 */
export function liveOwnedSession(sessions: readonly SessionSummary[]): SessionSummary | undefined {
  return sessions.find((s) => s.kind !== 'shell' && s.owned && s.status !== 'ended' && !s.detached)
}

/** The tail of `text`, at most `maxLines` lines and `maxChars` characters, with a line saying what was cut. The end of an output is where the error is. */
export function tailOf(text: string, maxLines = 120, maxChars = 6000): string {
  const lines = plainText(text).replace(/\s+$/, '').split('\n')
  let kept = lines.slice(-maxLines)
  let joined = kept.join('\n')
  if (joined.length > maxChars) {
    joined = joined.slice(joined.length - maxChars)
    joined = joined.slice(joined.indexOf('\n') + 1)
    kept = joined.split('\n')
  }
  const cut = lines.length - kept.length
  return cut > 0 ? `[${cut} earlier line${cut === 1 ? '' : 's'} cut]\n${joined}` : joined
}

/** Where a prompt went, said back to the user. */
export type HandoffResult = { sent: true; to: string; sessionId: string } | { sent: false; error: string }
