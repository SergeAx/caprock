/**
 * Keep the computer awake while agents work (ADR-049).
 *
 * `KeepAwakeSetting` is the Settings row: three modes and one line saying
 * what the chosen one does. The daemon stores the mode (`keep_awake` in
 * /v1/settings) and holds the OS's "no idle sleep" assertion itself; this
 * screen never asks the OS anything.
 *
 * `KeepAwakeIndicator` is the status strip's mark, drawn only while the
 * daemon is actually holding the machine awake.
 */
import { useEffect, useState } from 'react'
import { api, errText, isPairedDevice, type KeepAwakeMode, type KeepAwakeStatus, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Choice, Section } from './SettingsParts'
import { CoffeeIcon } from './AppIcons'

const OPTIONS: { value: KeepAwakeMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'working', label: 'While agents work' },
  { value: 'always', label: 'Always' },
]

const HINT: Record<KeepAwakeMode, string> = {
  off: 'Your computer sleeps on its usual schedule, even mid-task.',
  working: 'Your computer does not fall asleep while an agent is working or waiting for approval. The screen can still turn off.',
  always: 'Your computer does not fall asleep while Caprock runs. The screen can still turn off.',
}

/** A status line for the setting: what is happening now, or why it cannot. */
export function keepAwakeLine(st: KeepAwakeStatus | undefined): string {
  if (!st) return ''
  if (!st.available) return st.reason || 'This computer offers no way to stay awake.'
  if (st.error) return `Could not keep the computer awake: ${st.error}`
  if (st.holding) {
    if (st.mode === 'always') return 'Keeping this computer awake now.'
    return `Keeping this computer awake now · ${st.working} ${st.working === 1 ? 'agent' : 'agents'} working`
  }
  if (st.mode === 'working') return 'No agent is working, so your computer may sleep.'
  return ''
}

export function KeepAwakeSetting() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const status = useApi(() => api.keepAwake(), [], { live: false, intervalMs: 10_000 })
  const [picked, setPicked] = useState<KeepAwakeMode | null>(null)
  const [error, setError] = useState('')
  const refresh = status.refresh
  // The daemon acts on a change at once; ask again a moment later so the line
  // below says what it did, not what it was doing.
  useEffect(() => {
    if (!picked) return
    const t = window.setTimeout(refresh, 900)
    return () => window.clearTimeout(t)
  }, [picked, refresh])
  if (!settings.data) return null
  const value: KeepAwakeMode = picked ?? settings.data.keep_awake ?? 'working'
  const save = async (mode: KeepAwakeMode) => {
    setError('')
    setPicked(mode)
    try {
      await api.saveSettings({ keep_awake: mode } as Partial<Settings> as Settings)
    } catch (e) {
      setError(errText(e))
    }
  }
  const line = keepAwakeLine(status.data && { ...status.data, mode: value })
  const holding = status.data?.holding && value !== 'off'
  return (
    <Section
      id="settings-keep-awake"
      title="Keep awake"
      aside={holding ? <span className="inline-flex items-center gap-1 text-[12px] text-accent"><CoffeeIcon size={13} />awake now</span> : undefined}
    >
      <Choice label="Stay awake" value={value} options={OPTIONS} onChange={(m) => void save(m)} />
      <p className="text-[12px] leading-relaxed text-fg-muted">
        {HINT[value]} Closing a laptop&apos;s lid still puts it to sleep.
      </p>
      {line && value !== 'off' && <p className="text-[12px] text-fg-muted" data-keep-awake-line>{line}</p>}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}

/**
 * The status strip's mark. Its colour says whether the computer is held awake
 * this moment: accent with a live dot while it is, faint while it may sleep.
 * A click opens what it means and the three modes, so the mode changes where
 * it is noticed (owner, 2026-10-11, translated: "it is not clear whether it
 * is active right now or not, and a click should explain or set it").
 * Hidden when the mode is off or the OS offers no way to stay awake.
 */
export function KeepAwakeIndicator() {
  const owner = !isPairedDevice()
  const [open, setOpen] = useState(false)
  const st = useApi(() => (owner ? api.keepAwake() : Promise.resolve(undefined)), [owner], { live: false, intervalMs: open ? 3_000 : 15_000, keepUnchanged: true })
  const s = st.data
  if (!s || !s.available || s.mode === 'off') return open ? <KeepAwakePopover status={s} onClose={() => setOpen(false)} onChanged={st.refresh} /> : null
  const holding = s.holding
  const why = holding
    ? s.mode === 'always'
      ? 'Awake now: Caprock is keeping this computer awake while it runs.'
      : `Awake now: ${s.working} ${s.working === 1 ? 'agent is' : 'agents are'} working.`
    : 'May sleep: no agent is working.'
  return (
    <span className="relative">
      <button
        type="button"
        data-keep-awake
        data-holding={holding ? 'true' : 'false'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${why} Click for what this means.`}
        className={`inline-flex items-center gap-1 rounded-[5px] px-1 hover:bg-[var(--app-row-hover)] ${holding ? 'text-accent' : 'text-fg-faint'}`}
      >
        <span className="relative inline-flex">
          <CoffeeIcon size={12} />
          {holding && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-[5px] w-[5px] rounded-full bg-ok" />}
        </span>
        {holding ? 'awake' : 'may sleep'}
      </button>
      {open && <KeepAwakePopover status={s} onClose={() => setOpen(false)} onChanged={st.refresh} />}
    </span>
  )
}

/** What keep-awake is doing and the three modes, above the status strip. */
function KeepAwakePopover({ status, onClose, onChanged }: { status?: KeepAwakeStatus; onClose: () => void; onChanged: () => void }) {
  const [mode, setMode] = useState<KeepAwakeMode>(status?.mode ?? 'working')
  const [error, setError] = useState('')
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const save = async (m: KeepAwakeMode) => {
    setError('')
    setMode(m)
    try {
      await api.saveSettings({ keep_awake: m } as Partial<Settings> as Settings)
      window.setTimeout(onChanged, 900)
    } catch (e) {
      setError(errText(e))
    }
  }
  const line = keepAwakeLine(status && { ...status, mode })
  return (
    <>
      <span aria-hidden className="fixed inset-0 z-40" onClick={onClose} />
      <div role="dialog" aria-label="Keep awake" data-keep-awake-popover
        className="absolute bottom-[calc(100%+8px)] right-0 z-50 grid w-[320px] gap-2 rounded-[10px] border border-border-strong bg-panel p-3 text-left text-[12px] text-fg shadow-lg">
        <div className="flex items-center gap-1.5 font-medium"><CoffeeIcon size={13} />Keep awake</div>
        <span className="inline-flex flex-wrap gap-1 rounded-md bg-panel-2 p-0.5" role="radiogroup" aria-label="Stay awake">
          {OPTIONS.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={mode === o.value} onClick={() => void save(o.value)}
              className={`rounded-[5px] px-2 py-0.5 ${mode === o.value ? 'bg-accent font-medium text-panel' : 'text-fg-muted hover:text-fg'}`}>
              {o.label}
            </button>
          ))}
        </span>
        <p className="leading-relaxed text-fg-muted">{HINT[mode]} Closing a laptop&apos;s lid still puts it to sleep.</p>
        {line && mode !== 'off' && <p className="text-fg-muted">{line}</p>}
        {error && <p className="text-danger">{error}</p>}
      </div>
    </>
  )
}
