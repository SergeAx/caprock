import { describe, expect, it } from 'vitest'
import { githubRepoOf, itemBranchName, itemMatches, itemPrompt, trimBody, type GitHubItem } from './fromGitHub'

const issue: GitHubItem = { number: 123, title: 'Login fails on Safari 18!', url: 'https://github.com/ada/app/issues/123', author: 'grace', labels: [{ name: 'bug' }], pr: false, body: 'Steps:\n1. open it', comments: 0 }
const pr: GitHubItem = { ...issue, number: 45, title: 'Fix the login', url: 'https://github.com/ada/app/pull/45', pr: true, body: '' }

describe('from a GitHub issue or pull request', () => {
  it('reads a GitHub remote the way the daemon does', () => {
    expect(githubRepoOf('git@github.com:ada/app.git')).toBe('ada/app')
    expect(githubRepoOf('https://github.com/ada/app')).toBe('ada/app')
    expect(githubRepoOf('ssh://git@github.com/ada/my.app.git')).toBe('ada/my.app')
    expect(githubRepoOf('https://gitlab.com/ada/app.git')).toBeNull()
    expect(githubRepoOf(undefined)).toBeNull()
  })

  it('names the copy after the item', () => {
    expect(itemBranchName(issue)).toBe('issue-123-login-fails-on-safari-18')
    expect(itemBranchName(pr)).toBe('pr-45-fix-the-login')
    expect(itemBranchName({ ...issue, title: '日本語' })).toBe('issue-123')
  })

  it('prefills the first message with the title, the link and the text', () => {
    expect(itemPrompt(issue)).toBe('Work on issue #123: Login fails on Safari 18!\nhttps://github.com/ada/app/issues/123\n\nSteps:\n1. open it')
    const p = itemPrompt(pr)
    expect(p.startsWith('Review and continue pull request #45: Fix the login\nhttps://github.com/ada/app/pull/45\n\n')).toBe(true)
    expect(p).toContain("checked out at the pull request's head")
  })

  it('trims a long text at a line break, drops template comments, and says where the rest is', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} of the report`).join('\n')
    const t = trimBody(`<!-- describe the bug -->\n${long}`, 500)
    expect(t).not.toContain('describe the bug')
    expect(t.length).toBeLessThan(560)
    expect(t.endsWith('[…trimmed; the rest is at the link above]')).toBe(true)
    expect(t.split('\n\n')[0]!.endsWith('of the report')).toBe(true)
    expect(trimBody('short')).toBe('short')
  })

  it('matches a number, words in the title, the author or a label', () => {
    expect(itemMatches(issue, '#12')).toBe(true)
    expect(itemMatches(issue, '45')).toBe(false)
    expect(itemMatches(issue, 'safari login')).toBe(true)
    expect(itemMatches(issue, 'grace')).toBe(true)
    expect(itemMatches(issue, 'bug')).toBe(true)
    expect(itemMatches(issue, 'chrome')).toBe(false)
  })
})
