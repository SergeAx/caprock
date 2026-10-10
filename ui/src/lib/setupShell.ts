/**
 * Opening a shell tab with a command typed and not run, from a screen that is
 * not the app shell — Settings → Subscriptions' sign-in (ADR-048).
 *
 * The app shell owns the tabs, and its `setupAgent` already does exactly this
 * for an agent's install or sign-in (ADR-046), so it provides that function
 * here rather than Settings growing a second way to open a tab. In a browser
 * there is no app shell and no tab strip: the value is null, and the caller
 * shows the command to copy instead.
 */
import { createContext, useContext } from 'react'

export type SetupShell = (command: string, home?: string) => void

export const SetupShellContext = createContext<SetupShell | null>(null)

export function useSetupShell(): SetupShell | null {
  return useContext(SetupShellContext)
}
