import { useEffect, useMemo, useState } from 'react'
import { api, type CatalogEntry, type Status } from '@/lib/api'
import { useApi } from '@/lib/useApi'

/**
 * Which coding agent a new session runs.
 *
 * One component, because more than one place starts a session — the New
 * session dialog, and a project row's "New session here" — and a second copy
 * of this list is how one of them ends up offering an agent the other does
 * not, or remembering a choice the other ignores.
 *
 * Since 2026-10-10 (ADR-045) the list comes from `GET /v1/agents/catalog`:
 * every agent Caprock knows, installed or not, with its models and what is
 * missing, plus the user's custom agents. An agent that is not installed is
 * never the default choice, but it is listed, so the way to set it up is one
 * pick away rather than nowhere.
 */

/** The agents Caprock knows by name. */
export type BuiltinAgent = 'claude' | 'codex' | 'opencode' | 'gemini' | 'grok'
/** A built-in agent, or one the user added in Settings → Agents. */
export type SpawnAgent = BuiltinAgent | `custom:${string}`

export const SPAWN_AGENTS: { key: BuiltinAgent; label: string }[] = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
  // No billing note here: Gemini CLI signs in with Google as well as with a
  // key, so "your own key" told most people something untrue.
  { key: 'gemini', label: 'Gemini CLI' },
  { key: 'grok', label: 'Grok' },
]

export function isCustomAgent(a: string): a is `custom:${string}` {
  return a.startsWith('custom:')
}

/** The agents this machine can start, from the daemon's status. An agent is
 *  offered only when its binary was found: a choice that fails on click is
 *  worse than no choice. */
export function spawnableAgents(s?: Partial<Status>): SpawnAgent[] {
  if (!s) return []
  const has: Record<BuiltinAgent, boolean | undefined> = {
    claude: s.claude_available,
    codex: s.codex_available,
    opencode: s.opencode_available,
    gemini: s.gemini_available,
    grok: s.grok_available,
  }
  return SPAWN_AGENTS.map((a) => a.key).filter((k) => has[k])
}

/** The catalog an older daemon cannot give, made from its status: installed
 *  or not, and nothing else known. */
export function entriesFromStatus(s?: Partial<Status>): CatalogEntry[] {
  const have = spawnableAgents(s)
  return SPAWN_AGENTS.map((a) => ({
    id: a.key, label: a.label, installed: have.includes(a.key), ready: have.includes(a.key),
    models: [], observed: a.key !== 'grok', prompt: true,
  }))
}

/** The agents a session can start on: installed, and not locked. */
export function startable(entries: readonly CatalogEntry[]): SpawnAgent[] {
  return entries.filter((e) => e.installed && !e.locked).map((e) => e.id as SpawnAgent)
}

/** The daemon's catalog, fetched once; the status stands in on a daemon
 *  that predates it. */
export function useAgentCatalog(): { entries: CatalogEntry[]; loaded: boolean; home?: string; licensed: boolean; refresh: () => void } {
  const catalog = useApi(() => api.agentCatalog(), [], { live: false })
  const status = useApi(() => (catalog.error ? api.status() : Promise.resolve(undefined)), [!!catalog.error], { live: false })
  const entries = useMemo(
    () => catalog.data?.agents ?? (catalog.error ? entriesFromStatus(status.data) : []),
    [catalog.data, catalog.error, status.data],
  )
  return {
    entries,
    loaded: !!catalog.data || (!!catalog.error && (!!status.data || !!status.error)),
    home: catalog.data?.home,
    licensed: !!catalog.data?.licensed,
    refresh: () => catalog.refresh?.(),
  }
}

/** The daemon's answer, fetched once. A caller that already has the status
 *  passes it instead. */
export function useSpawnableAgents(known?: Partial<Status>): SpawnAgent[] {
  const { entries } = useAgentCatalog()
  const fromCatalog = startable(entries)
  const fromKnown = spawnableAgents(known)
  return useMemo(() => [...fromCatalog, ...fromKnown.filter((k) => !fromCatalog.includes(k))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fromCatalog.join(','), fromKnown.join(',')])
}

/** What an agent is called, custom ones by the name the user gave. */
export function agentLabel(id: string, entries?: readonly CatalogEntry[]): string {
  return entries?.find((e) => e.id === id)?.label ?? SPAWN_AGENTS.find((a) => a.key === id)?.label ?? id.replace(/^custom:/, '')
}

// Per viewer and per browser: which agent someone reaches for is a habit of
// the person at this keyboard, not a setting of the machine.
const KEY = 'caprock.spawn.agent'

export function rememberedAgent(): SpawnAgent | undefined {
  try {
    const v = localStorage.getItem(KEY)
    return v && (SPAWN_AGENTS.some((a) => a.key === v) || isCustomAgent(v)) ? (v as SpawnAgent) : undefined
  } catch {
    return undefined // private mode, blocked storage: no memory, no failure
  }
}

export function rememberAgent(a: SpawnAgent) {
  try {
    localStorage.setItem(KEY, a)
  } catch {
    // Not remembering is fine; failing to start a session over it is not.
  }
}

/**
 * The agent a picker starts on: the one this viewer chose last, if the machine
 * still has it, otherwise the first one it has. Follows `agents` as it loads —
 * the status arrives after the first render — until the viewer picks one.
 */
export function useAgentChoice(agents: SpawnAgent[]): [SpawnAgent, (a: SpawnAgent) => void] {
  const pick = (): SpawnAgent => {
    const last = rememberedAgent()
    if (last && agents.includes(last)) return last
    return agents[0] ?? 'claude'
  }
  const [agent, setAgent] = useState<SpawnAgent>(pick)
  const [touched, setTouched] = useState(false)
  const key = agents.join(',')
  useEffect(() => {
    if (!touched) setAgent(pick())
    // pick reads only `agents`, which `key` stands for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, touched])
  const choose = (a: SpawnAgent) => {
    setTouched(true)
    setAgent(a)
    // An agent picked only to read how to set it up is not a habit.
    if (agents.includes(a)) rememberAgent(a)
  }
  return [agent, choose]
}

/** The control itself. Renders nothing when there is only one agent to pick
 *  and nothing to set up: a select with one option is a question with no
 *  choice in it. With `entries`, the agents that are not installed are listed
 *  after the rest, marked, so picking one shows how to set it up. */
export function AgentPicker({
  value,
  agents,
  entries,
  onChange,
  className = 'input',
}: {
  value: SpawnAgent
  agents: SpawnAgent[]
  entries?: readonly CatalogEntry[]
  onChange: (a: SpawnAgent) => void
  className?: string
}) {
  const options: { key: string; label: string }[] = entries
    ? [
        ...entries.filter((e) => agents.includes(e.id as SpawnAgent)).map((e) => ({ key: e.id, label: e.label })),
        ...entries.filter((e) => !agents.includes(e.id as SpawnAgent)).map((e) => ({ key: e.id, label: `${e.label} · ${e.locked ? 'Premium' : 'not installed'}` })),
      ]
    : SPAWN_AGENTS.filter((a) => agents.includes(a.key))
  if (options.length < 2) return null
  return (
    <label className="grid min-w-0 gap-1">
      <span className="text-[11px] text-fg-muted">Agent</span>
      <select className={className} value={value} onChange={(e) => onChange(e.target.value as SpawnAgent)}>
        {options.map((a) => (
          <option key={a.key} value={a.key}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  )
}
