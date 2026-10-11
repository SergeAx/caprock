/**
 * A project's setup command (ADR-050): what runs in a new copy's terminal
 * before its agent starts — `npm install`, `uv sync` — with the output in
 * that terminal, a ten-minute limit, and Ctrl+C to skip it. Stored in the
 * project's defaults (`setup_command`). Shown where a new copy is asked for,
 * so what will run is in sight, and editable there; on a paired device it is
 * read-only, because the daemon runs it on this machine.
 *
 * The other half of "ready to run", .worktreeinclude, needs no setting: the
 * repository's own file says which ignored files (.env) come along.
 */
import { useState } from 'react'
import { errText, isPairedDevice } from '@/lib/api'
import { projectsApi, setupPatch, type Project } from '@/lib/projects'

export const SETUP_HINT = 'runs in a new copy before its agent starts'

const INCLUDE_TITLE = "Ignored files matching the repository's .worktreeinclude are copied from this folder into every new copy."

export function ProjectSetupCommand({ project, onSaved }: { project: Project; onSaved?: (p: Project) => void }) {
  const saved = project.defaults?.setup_command ?? ''
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(saved)
  const [shown, setShown] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const owner = !isPairedDevice()

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const p = await projectsApi.patch(project.id, setupPatch(project.defaults, text))
      setShown(p.defaults?.setup_command ?? '')
      onSaved?.(p)
      setEditing(false)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className="grid min-w-0 gap-1" data-setup-command>
        <span className="flex items-baseline gap-2 text-[12px] font-medium text-fg-muted">
          Setup
          <span className="font-normal text-fg-faint">{SETUP_HINT}</span>
          {owner && (
            <button type="button" onClick={() => { setText(shown); setEditing(true) }} className="ml-auto text-[12px] font-normal text-accent hover:underline">
              {shown ? 'Edit' : 'Add'}
            </button>
          )}
        </span>
        {shown ? (
          <p className="mono truncate text-[12.5px] text-fg" title={shown}>{shown}</p>
        ) : (
          // The include file is named in the tooltip, not the text: the sheet
          // speaks of copies, never of worktrees (owner, 2026-10-09).
          <p className="text-[12.5px] text-fg-faint" title={INCLUDE_TITLE}>
            None. Ignored files the repository lists for copies, such as <span className="mono">.env</span>, come along anyway.
          </p>
        )}
      </div>
    )
  }
  return (
    <div className="grid min-w-0 gap-1.5" data-setup-command>
      <span className="flex items-baseline gap-2 text-[12px] font-medium text-fg-muted">
        Setup <span className="font-normal text-fg-faint">{SETUP_HINT}</span>
      </span>
      <input
        aria-label="Setup command"
        className="input mono text-[12.5px]"
        autoFocus
        placeholder="npm install"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter saves the command; it must not also start the agent.
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void save() }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false) }
        }}
      />
      <p className="text-[12px] leading-snug text-fg-faint">
        Its output shows in the agent&apos;s terminal. A failure or ten minutes without finishing starts the agent anyway; Ctrl+C skips it.
      </p>
      <div className="flex items-center gap-2">
        {error && <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger" title={error}>{error}</p>}
        <button type="button" onClick={() => setEditing(false)} className="ml-auto h-[26px] rounded-[6px] px-3 text-[12.5px] text-fg-muted hover:text-fg">Cancel</button>
        <button type="button" disabled={busy} onClick={() => void save()} className="h-[26px] rounded-[6px] bg-accent px-3 text-[12.5px] font-medium text-bg disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
