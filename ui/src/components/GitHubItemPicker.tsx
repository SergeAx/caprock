/**
 * New agent → From GitHub: a project's open issues and pull requests, to
 * start an agent on one. Read from the daemon when the picker opens (the
 * daemon asks GitHub and keeps the answer a minute), filtered as you type by
 * number, title, author or label; when GitHub has more open items than the
 * hundred listed, what you type also goes to GitHub's search, after a pause.
 *
 * Keys: the search has focus; ↑↓ move, Enter picks, Esc closes the list
 * before the sheet.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { githubApi, githubErrorText } from '@/lib/github'
import { itemMatches, type GitHubItem, type GitHubItems } from '@/lib/fromGitHub'
import { useEscapeToClose } from './Dialog'
import { SEARCH_DEBOUNCE_MS } from './RepoPicker'

export function GitHubItemPicker({ projectId, onPick, onClose }: { projectId: string; onPick: (item: GitHubItem) => void; onClose: () => void }) {
  const [list, setList] = useState<GitHubItems | null>(null)
  const [found, setFound] = useState<GitHubItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const seq = useRef(0)
  useEscapeToClose(onClose)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    githubApi.items(projectId)
      .then((r) => { if (alive) setList(r) })
      .catch((e: unknown) => { if (alive) setError(githubErrorText(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [projectId])

  // GitHub's search only when the list is not the whole set: otherwise the
  // filter below already has every open item.
  useEffect(() => {
    const q = query.trim()
    if (!list?.more || q.length < 2) { setFound(null); return }
    const t = window.setTimeout(() => {
      const n = ++seq.current
      setSearching(true)
      githubApi.items(projectId, q)
        .then((r) => { if (n === seq.current) setFound(r.items) })
        .catch(() => { /* the local filter still shows what it has */ })
        .finally(() => { if (n === seq.current) setSearching(false) })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, list?.more, projectId])

  const items = useMemo(() => {
    const local = (list?.items ?? []).filter((i) => itemMatches(i, query))
    if (!found) return local
    const seen = new Set(local.map((i) => i.number))
    return [...local, ...found.filter((i) => !seen.has(i.number))]
  }, [list, found, query])
  useEffect(() => { setActive(0) }, [query])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, Math.min(items.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && items[active]) {
      e.preventDefault()
      e.stopPropagation()
      onPick(items[active])
    }
  }

  if (list && !list.connected) {
    return <p className="text-[12px] leading-relaxed text-fg-faint">Connect GitHub in Settings → GitHub to start from an issue or a pull request.</p>
  }
  if (list?.reason) {
    return <p className="text-[12px] leading-relaxed text-fg-faint">{list.reason === 'no_remote' ? 'This project has no remote, so it has no issues on GitHub.' : 'This project’s remote is not on github.com.'}</p>
  }
  return (
    <div className="grid min-w-0 gap-1.5" aria-label="Open issues and pull requests">
      <input
        className="input"
        type="search"
        autoFocus
        aria-label="Search open issues and pull requests"
        placeholder={list?.repo ? `Search ${list.repo.full_name}: #number, words, author, label` : 'Search issues and pull requests'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="app-scroll max-h-[220px] overflow-y-auto rounded-[8px] border border-border" role="listbox" aria-label="Issues and pull requests">
        {items.map((it, i) => (
          <button
            key={it.number}
            type="button"
            role="option"
            aria-selected={i === active}
            tabIndex={-1}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(it)}
            className={`flex w-full min-w-0 items-baseline gap-2 border-b border-border/60 px-2.5 py-1.5 text-left last:border-0 ${i === active ? 'bg-accent/10' : 'hover:bg-panel-2'}`}
          >
            <span className="mono w-[52px] shrink-0 text-[12px] text-fg-muted">#{it.number}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-fg">
                {it.pr && <span className="mr-1.5 rounded-[4px] border border-border px-1 text-[10.5px] text-fg-muted">{it.draft ? 'draft PR' : 'PR'}</span>}
                {it.title}
              </span>
              <span className="block truncate text-[11.5px] text-fg-faint">
                {it.author && <>{it.author}</>}
                {it.labels.slice(0, 4).map((l) => <span key={l.name} className="ml-1.5 rounded-[4px] border border-border px-1 text-[10.5px] text-fg-muted">{l.name}</span>)}
                {it.labels.length > 4 && <span className="ml-1 text-[10.5px]">+{it.labels.length - 4}</span>}
              </span>
            </span>
          </button>
        ))}
        {loading && <p className="px-2.5 py-2 text-[12px] text-fg-faint" aria-busy="true">Reading GitHub…</p>}
        {!loading && !error && items.length === 0 && (
          <p className="px-2.5 py-2 text-[12px] text-fg-faint">{searching ? 'Searching GitHub…' : query.trim() ? `No open issue or pull request like “${query.trim()}”.` : 'No open issues or pull requests.'}</p>
        )}
        {!loading && searching && items.length > 0 && <p className="px-2.5 py-1.5 text-[11.5px] text-fg-faint" aria-busy="true">Searching GitHub…</p>}
      </div>
      {error && <p role="alert" className="text-[12px] leading-snug text-danger [overflow-wrap:anywhere]">{error}</p>}
      {list?.more && !query.trim() && <p className="text-[11.5px] text-fg-faint">The 100 most recently updated; type to search the rest.</p>}
    </div>
  )
}
