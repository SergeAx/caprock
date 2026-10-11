/**
 * In the desktop app, a click on a link meant for the browser opens it there
 * explicitly. The shell's new-window handler is meant to catch
 * `target="_blank"`, but a Windows user's *download it* in the update banner
 * opened nothing (2026-10-11), so the page no longer leaves it to the
 * webview: any such click goes through the shell's own opener.
 */
import { isTauri } from './appmode'
import { openExternal } from './nudges'

/** Whether a link leaves the dashboard: a new window, or another origin. */
export function isExternalLink(a: HTMLAnchorElement, origin = location.origin): boolean {
  const href = a.getAttribute('href') ?? ''
  if (!href || href.startsWith('#')) return false
  let url: URL
  try { url = new URL(href, origin) } catch { return false }
  if (!/^(https?|mailto):$/.test(url.protocol)) return false
  return a.target === '_blank' || url.origin !== origin
}

/** Installs the handler once; returns how to remove it. Outside the app it does nothing. */
export function installExternalLinks(): () => void {
  if (!isTauri()) return () => {}
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a || !isExternalLink(a)) return
    e.preventDefault()
    openExternal(new URL(a.getAttribute('href')!, location.origin).toString())
  }
  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}
