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

/** The status strip's mark: shown only while the computer is held awake. */
export function KeepAwakeIndicator() {
  const owner = !isPairedDevice()
  const st = useApi(() => (owner ? api.keepAwake() : Promise.resolve(undefined)), [owner], { live: false, intervalMs: 15_000, keepUnchanged: true })
  const s = st.data
  if (!s?.holding) return null
  const why = s.mode === 'always'
    ? 'Caprock is keeping this computer awake while it runs.'
    : `Caprock is keeping this computer awake: ${s.working} ${s.working === 1 ? 'agent is' : 'agents are'} working.`
  return (
    <span data-keep-awake className="inline-flex items-center gap-1 text-fg-muted" title={`${why} The screen can still turn off. Settings → Keep awake.`}>
      <CoffeeIcon size={12} />
      awake
    </span>
  )
}
