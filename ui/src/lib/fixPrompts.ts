/**
 * The prompts "Fix with agent" hands to the agent working in a worktree
 * (lib/handoff.ts): what failed, the output that says why — its tail, where
 * the error is — and what to do. Each one leaves committing, pushing and
 * finishing a merge to the user, who clicked the button to get a fix, not a
 * release.
 */
import { tailOf } from './handoff'
import type { PRCheck } from './github'

const fence = (s: string) => `\`\`\`\n${s}\n\`\`\``

/** The operation a worktree is in the middle of, as a noun: "merging" is a merge. */
export function opName(state?: string): string {
  switch (state) {
    case 'merging': return 'merge'
    case 'rebasing': return 'rebase'
    case 'cherry-picking': return 'cherry-pick'
    case 'reverting': return 'revert'
    default: return state ?? ''
  }
}

function on(branch?: string): string {
  return branch ? ` on ${branch}` : ''
}

/** A commit or a push a git hook refused, with what the hook printed. */
export function hookFixPrompt(doing: 'commit' | 'push', message: string, output: string | undefined, branch?: string): string {
  const head = `This failed: ${doing === 'commit' ? 'committing' : 'pushing'} in this worktree${on(branch)} — ${message.replace(/\.$/, '')}. Find the cause and fix it, then tell me what you changed. Do not commit or push; I will.`
  const out = output?.trim() ? `\n\nWhat the hook printed${output.split('\n').length > 120 ? ' (the end of it)' : ''}:\n${fence(tailOf(output))}` : ''
  return head + out
}

/** The checks that failed on the worktree's pull request, by name, with their links. */
export function checksFixPrompt(pr: { number: number; url: string; branch?: string }, failing: readonly PRCheck[]): string {
  const list = failing.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n')
  return [
    `This failed: ${failing.length === 1 ? 'a check' : `${failing.length} checks`} on pull request #${pr.number}${on(pr.branch)} (${pr.url}). Find the cause and fix it, then tell me what you changed. Do not push; I will.`,
    list,
    `Read the failing logs first — with the GitHub CLI, \`gh pr checks ${pr.number}\` lists them and \`gh run view <run id> --log-failed\` prints a failed run's log — and reproduce the failure locally where you can.`,
  ].join('\n\n')
}

/** Files left in conflict by a merge, rebase, cherry-pick or stash in this worktree. */
export function conflictsFixPrompt(files: readonly string[], state?: string, branch?: string): string {
  const op = opName(state)
  const shown = files.slice(0, 50)
  const more = files.length > shown.length ? `\n- … and ${files.length - shown.length} more` : ''
  return [
    `This failed: ${op ? `a ${op}` : 'git'} left ${files.length === 1 ? 'a file' : `${files.length} files`} in conflict in this worktree${on(branch)}. Resolve the conflicts so that both sides' intent is kept, remove every conflict marker, make sure it builds and the tests pass, and stage the files. Then tell me what you decided where the two sides disagreed. Do not commit${op ? `, continue or abort the ${op}` : ''}; I will.`,
    shown.map((f) => `- ${f}`).join('\n') + more,
  ].join('\n\n')
}

/** A pull request GitHub says cannot merge into its base because of conflicts. */
export function prConflictsFixPrompt(pr: { number: number; url: string; base: string; branch?: string }): string {
  return `This failed: pull request #${pr.number}${on(pr.branch)} (${pr.url}) has conflicts with ${pr.base} and cannot be merged. Fetch the remote, merge its ${pr.base} into this branch, resolve the conflicts so that both sides' intent is kept, make sure it builds and the tests pass, and stage the result. Then tell me what you decided where the two sides disagreed. Do not commit or push; I will.`
}
