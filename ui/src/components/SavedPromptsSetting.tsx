/**
 * Settings → Saved prompts and commands (ADR-051).
 *
 * A prompt is something you say to an agent often — "run the tests and fix
 * what fails" — sent to the session in front from ⌘K, the strip's + menu
 * (*Run saved…*) or a chip above the phone's message field. A command is one
 * shell line — `pnpm dev` — run in a new shell tab in the folder in front.
 * Each is for every project or for one. The daemon keeps them, so the phone
 * has the same list; only this machine changes it.
 */
import { useEffect, useMemo, useState } from 'react'
import { errText } from '@/lib/api'
import { projectsApi, type Project } from '@/lib/projects'
import { draftProblem, reloadSaved, savedApi, savedChanged, useSavedPrompts, type SavedDraft, type SavedPrompt } from '@/lib/saved'
import { Section } from './SettingsParts'

const EMPTY: SavedDraft = { kind: 'prompt', name: '', text: '', project_id: 0 }

export const SAVED_SECTION_ID = 'saved-prompts'

export function SavedPromptsEditor() {
  const saved = useSavedPrompts(true)
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    let alive = true
    projectsApi.list().then((list) => { if (alive) setProjects(list.filter((p) => !p.archived_at)) }).catch(() => {})
    return () => { alive = false }
  }, [])
  const [draft, setDraft] = useState<SavedDraft>(EMPTY)
  /** The row being changed; null while adding. */
  const [editing, setEditing] = useState<number | null>(null)
  const [state, setState] = useState('')
  const [busy, setBusy] = useState(false)

  // A row's project may be unlisted since: it stays a choice, by name.
  const scopes = useMemo(() => {
    const out = projects.map((p) => ({ id: Number(p.id), name: p.name })).filter((p) => Number.isInteger(p.id) && p.id > 0)
    for (const v of saved.items) {
      if (v.project_id && !out.some((p) => p.id === v.project_id)) out.push({ id: v.project_id, name: v.project_name || `project ${v.project_id}` })
    }
    return out
  }, [projects, saved.items])

  const reset = () => { setDraft(EMPTY); setEditing(null) }
  const edit = (v: SavedPrompt) => {
    setEditing(v.id)
    setDraft({ kind: v.kind, name: v.name, text: v.text, project_id: v.project_id ?? 0 })
    setState('')
  }

  const submit = async () => {
    const problem = draftProblem(draft)
    if (problem) { setState(problem); return }
    setBusy(true)
    setState('')
    try {
      const body: SavedDraft = { ...draft, name: draft.name.trim(), text: draft.text.trim() }
      const { item } = editing === null ? await savedApi.add(body) : await savedApi.update(editing, body)
      const rest = saved.items.filter((x) => x.id !== item.id)
      savedChanged([...rest, item])
      void reloadSaved()
      reset()
      setState('saved')
    } catch (e) {
      setState(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (v: SavedPrompt) => {
    setBusy(true)
    setState('')
    try {
      await savedApi.remove(v.id)
      savedChanged(saved.items.filter((x) => x.id !== v.id))
      if (editing === v.id) reset()
    } catch (e) {
      setState(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const isCommand = draft.kind === 'command'
  return (
    <div className="grid gap-3">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        A <span className="text-fg">prompt</span> is sent to the agent in front: from <span className="mono">⌘K</span>, the tab strip’s <span className="text-fg">+</span> → <span className="text-fg">Run saved…</span>, or a chip above the message field on your phone. A <span className="text-fg">command</span> runs in a new shell tab in the folder in front. Prompts go only to sessions Caprock started.
      </p>
      {saved.error && !saved.items.length && <p role="alert" className="text-[12px] text-danger">{saved.error}</p>}
      {saved.items.length > 0 && (
        <ul className="grid gap-1.5" aria-label="Saved prompts and commands">
          {saved.items.map((v) => (
            <li key={v.id} className={`flex min-w-0 items-center gap-3 rounded-[8px] border px-3 py-2 ${editing === v.id ? 'border-accent' : 'border-border'}`}>
              <span className="w-[62px] shrink-0 text-[11px] uppercase tracking-[0.06em] text-fg-faint">{v.kind}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-fg">{v.name} <span className="text-[11.5px] text-fg-faint">· {v.project_id ? v.project_name || 'one project' : 'every project'}</span></p>
                <p className={`truncate text-[11.5px] text-fg-muted ${v.kind === 'command' ? 'mono' : ''}`} title={v.text}>{v.text}</p>
              </div>
              <button type="button" disabled={busy} onClick={() => edit(v)} className="shrink-0 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50">Edit</button>
              <button type="button" disabled={busy} onClick={() => void remove(v)} aria-label={`Delete ${v.name}`} className="shrink-0 text-[12px] text-fg-muted hover:text-danger disabled:opacity-50">Delete</button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 rounded-[8px] border border-border p-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
          <label className="grid min-w-0 gap-1">
            <span className="text-[12px] text-fg-muted">Kind</span>
            <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as SavedDraft['kind'] })}>
              <option value="prompt">Prompt</option>
              <option value="command">Command</option>
            </select>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="text-[12px] text-fg-muted">Name</span>
            <input className="input" placeholder={isCommand ? 'Dev server' : 'Fix the tests'} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="text-[12px] text-fg-muted">For</span>
            <select className="input" value={draft.project_id} onChange={(e) => setDraft({ ...draft, project_id: Number(e.target.value) })}>
              <option value={0}>Every project</option>
              {scopes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        <label className="grid min-w-0 gap-1">
          <span className="text-[12px] text-fg-muted">{isCommand ? <>Command <span className="text-fg-faint">· one line, run in a new shell tab</span></> : <>Prompt <span className="text-fg-faint">· sent as you would type it, then Enter</span></>}</span>
          {isCommand
            ? <input className="input mono" spellCheck={false} placeholder="pnpm dev" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }} />
            : <textarea className="input min-h-[76px] resize-y font-[family-name:var(--font-sans)] text-[13px] leading-relaxed" placeholder="Run the tests and fix what fails." value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />}
        </label>
        <div className="flex items-center gap-3">
          <button type="button" disabled={busy} onClick={() => void submit()} className="h-[28px] rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-panel hover:brightness-110 disabled:opacity-50">
            {editing === null ? (isCommand ? 'Add command' : 'Add prompt') : 'Save'}
          </button>
          {editing !== null && <button type="button" disabled={busy} onClick={reset} className="text-[12.5px] text-fg-muted hover:text-fg">Cancel</button>}
          {state === 'saved' && <span className="text-[12px] text-fg-muted">Saved.</span>}
          {state && state !== 'saved' && <span role="alert" className="min-w-0 truncate text-[12px] text-danger" title={state}>{state}</span>}
        </div>
      </div>
    </div>
  )
}

export function SavedPromptsSetting() {
  return (
    <Section id={SAVED_SECTION_ID} title="Saved prompts and commands">
      <SavedPromptsEditor />
    </Section>
  )
}
