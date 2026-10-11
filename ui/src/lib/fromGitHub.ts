/**
 * Start an agent from a GitHub issue or pull request (New agent → From
 * GitHub): the words that turn a picked item into a branch name and a first
 * message, both prefilled and editable before Start. The list itself comes
 * from the daemon (`GET /v1/projects/{id}/github/items`), which holds the
 * token and makes the call.
 */
import { worktreeSlug } from './slug'

export interface GitHubLabel { name: string; color?: string }

/** One open issue or pull request, as the daemon lists it. */
export interface GitHubItem {
  number: number
  title: string
  url: string
  author?: string
  labels: GitHubLabel[]
  /** A pull request (GitHub lists them with the issues). */
  pr: boolean
  draft?: boolean
  body?: string
  comments: number
  updated_at?: string
}

/** `GET /v1/projects/{id}/github/items[?q=]`. */
export interface GitHubItems {
  connected: boolean
  repo: { owner: string; name: string; full_name: string; html_url: string } | null
  reason?: 'no_remote' | 'not_github'
  items: GitHubItem[]
  /** More open items than listed: the 100 most recently updated are. */
  more: boolean
  search?: boolean
  at: number
}

/** The repository a remote URL names on github.com, else null (as the daemon's ParseRemote). */
export function githubRepoOf(remote?: string): string | null {
  const s = (remote ?? '').trim()
  const m = /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(s)
  return m ? `${m[1]}/${m[2]}` : null
}

/** The new copy's name: `issue-123-short-slug`, `pr-45-short-slug`. */
export function itemBranchName(item: GitHubItem): string {
  const slug = worktreeSlug(item.title).split('-').slice(0, 5).join('-').slice(0, 32).replace(/-+$/, '')
  return `${item.pr ? 'pr' : 'issue'}-${item.number}${slug ? `-${slug}` : ''}`
}

/** How much of an issue's text goes into the first message. */
export const BODY_MAX = 3000

/**
 * An issue's or pull request's text, cut to `max` characters at a paragraph
 * or line break when one is near, with HTML comments (issue templates' hints)
 * left out, and a note that the rest is at the link.
 */
export function trimBody(body: string | undefined, max = BODY_MAX): string {
  let s = (body ?? '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'))
  s = (at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()
  return `${s}\n\n[…trimmed; the rest is at the link above]`
}

/** The first message, prefilled: the item's title, link and text. */
export function itemPrompt(item: GitHubItem): string {
  const body = trimBody(item.body)
  const head = item.pr
    ? `Review and continue pull request #${item.number}: ${item.title}\n${item.url}\n\nThis copy is checked out at the pull request's head. Read the change against its base, say what you find, and carry on with it if it is not finished.`
    : `Work on issue #${item.number}: ${item.title}\n${item.url}`
  return body ? `${head}\n\n${body}` : head
}

/** Whether an item matches what was typed: its number, title, author or a label. */
export function itemMatches(item: GitHubItem, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, '')
  if (!q) return true
  if (/^\d+$/.test(q)) return String(item.number).startsWith(q)
  return q.split(/\s+/).every((w) =>
    item.title.toLowerCase().includes(w) ||
    (item.author ?? '').toLowerCase().includes(w) ||
    item.labels.some((l) => l.name.toLowerCase().includes(w)))
}
