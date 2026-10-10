/**
 * The desktop app's interface size. The shell zooms its webview natively
 * (app/src-tauri/src/commands.rs set_zoom): CSS zoom would scale the
 * terminal's canvas without telling xterm, and its mouse positions would
 * drift. A browser has its own ⌘+ and ⌘−, so this is the app's alone.
 */
import { useSyncExternalStore } from 'react'
import { isTauri } from './appmode'
import { shell } from './shell'

export const UI_SCALES = [1, 1.1, 1.25, 1.4] as const
export type UiScale = (typeof UI_SCALES)[number]

/** The app opens a step up: at 100% its 12px labels read small on a laptop. */
export const DEFAULT_UI_SCALE: UiScale = 1.1

const KEY = 'caprock.uiScale'
const listeners = new Set<() => void>()

function read(): UiScale {
  try {
    const n = Number(localStorage.getItem(KEY))
    return (UI_SCALES as readonly number[]).includes(n) ? (n as UiScale) : DEFAULT_UI_SCALE
  } catch {
    return DEFAULT_UI_SCALE
  }
}

let current: UiScale = read()

export function getUiScale(): UiScale {
  return current
}

export function setUiScale(s: UiScale): void {
  current = s
  try {
    localStorage.setItem(KEY, String(s))
  } catch {
    // Private storage: the size holds until the window closes.
  }
  applyUiScale()
  listeners.forEach((l) => l())
}

/** One step bigger (1), smaller (-1) or back to the default (0), clamped to the list. */
export function stepUiScale(step: 1 | -1 | 0): void {
  if (step === 0) return setUiScale(DEFAULT_UI_SCALE)
  const i = UI_SCALES.indexOf(current) + step
  setUiScale(UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, i))] ?? DEFAULT_UI_SCALE)
}

/** Hands the size to the shell; a no-op in a browser. */
export function applyUiScale(): void {
  if (isTauri()) shell.setZoom(current).catch(() => {})
}

export function useUiScale(): UiScale {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}
